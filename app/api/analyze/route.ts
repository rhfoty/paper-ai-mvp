import { NextResponse } from "next/server";
import { PDFParse } from "pdf-parse";
import OpenAI from "openai";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/session";

// 최대 업로드 용량 (임시 상한값)
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
// 스캔 이미지 PDF처럼 글자를 거의 못 읽어온 경우도 "추출 불가"로 처리하기 위한 최소 글자 수
const MIN_EXTRACTED_TEXT_LENGTH = 20;
// PRD 규칙: 처리 대상은 최대 30페이지
const MAX_PAGE_COUNT = 30;
// 핵심 요약 글자 수 제한 (PRD 규칙)
const SUMMARY_MAX_LENGTH = 500;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// CLAUDE.md 핵심 기능 규칙: 환각 금지 + 영어 기술 용어 유지 + 500자 제한
const SUMMARY_SYSTEM_PROMPT = `당신은 생명공학·의약학 분야 대학원생을 돕는 논문 요약 도우미입니다.
반드시 지켜야 할 규칙:
1. 아래 사용자 메시지로 주어진 논문 텍스트에 없는 내용은 절대 추측해서 넣지 않는다 (환각 금지).
2. 응답은 500자 이내의 한국어로 작성한다.
3. 핵심 기술 용어·지표·약어·포맷 명칭은 한국어로 번역하지 않고 영어 원문 그대로 사용하고, 문장 구조만 자연스러운 한국어로 작성한다.
4. 논문의 연구 목적, 방법, 핵심 결과를 중심으로 핵심만 요약한다.`;

async function generateSummary(pagedText: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: pagedText },
    ],
    max_tokens: 600,
  });

  const summary = completion.choices[0]?.message?.content?.trim() ?? "";
  // 모델이 글자 수 지시를 넘길 경우를 대비한 최종 안전장치
  return summary.length > SUMMARY_MAX_LENGTH
    ? summary.slice(0, SUMMARY_MAX_LENGTH)
    : summary;
}

export type DetailedSummary = {
  keyTerms: string;
  motivation: string;
  methodResults: string;
  conclusion: string;
};

// DESIGN.md 흐름1 ⑤: 500자 핵심 요약과 별도의 두 번째 OpenAI 호출로 4단계 상세 요약을 생성한다.
// 주의: 필드 설명을 JSON 예시 값 자리에 넣으면 모델이 설명 문구 자체를 그대로 복사하는
// 문제가 있어(직접 테스트로 확인), 필드 설명과 응답 형식 예시를 분리해서 지시한다.
const DETAILED_SUMMARY_SYSTEM_PROMPT = `당신은 생명공학·의약학 분야 대학원생을 돕는 논문 요약 도우미입니다.
반드시 지켜야 할 규칙:
1. 아래 사용자 메시지로 주어진 논문 텍스트에 없는 내용은 절대 추측해서 넣지 않는다 (환각 금지). 논문에 해당 정보가 없으면 그 항목에는 "논문에서 확인할 수 없습니다"라고 쓴다.
2. 핵심 기술 용어·지표·약어·포맷 명칭은 한국어로 번역하지 않고 영어 원문 그대로 사용하고, 문장 구조만 자연스러운 한국어로 작성한다.
3. 각 항목의 글자 수 제한은 없다.
4. 아래 4개 항목 각각에 대해, 설명 문구를 그대로 베끼지 말고 실제 논문 내용을 바탕으로 작성한다:
- keyTerms: 논문에서 가장 중요한 약어·포맷·기술적 개념 3~5가지를 선정해 각각을 정의
- motivation: 저자들이 해결하려는 핵심 문제와 기존 연구(Baseline)의 한계
- methodResults: 제안 방법론과 주요 실험 결과(구체적 수치·비교 우위 중심)
- conclusion: 논문의 결론과 해당 분야(학계 또는 산업계)에 미치는 영향
5. 다른 설명 없이 아래 형식의 JSON 객체 하나만 응답한다: {"keyTerms": string, "motivation": string, "methodResults": string, "conclusion": string}`;

async function generateDetailedSummary(pagedText: string): Promise<DetailedSummary> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: DETAILED_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: pagedText },
    ],
    max_tokens: 2000,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Partial<DetailedSummary>;

  return {
    keyTerms: parsed.keyTerms ?? "",
    motivation: parsed.motivation ?? "",
    methodResults: parsed.methodResults ?? "",
    conclusion: parsed.conclusion ?? "",
  };
}

export async function POST(request: Request) {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { message: "일시적인 오류가 발생했습니다. 다시 시도해주세요" },
      { status: 500 },
    );
  }

  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { message: "PDF 파일만 업로드할 수 있습니다" },
      { status: 400 },
    );
  }

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json(
      { message: "PDF 파일만 업로드할 수 있습니다" },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      { message: "파일 용량이 너무 큽니다" },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let pages: { num: number; text: string }[];
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    pages = result.pages;
  } catch (error) {
    // 사용자에게는 안내 문구만 보여주되, 원인은 서버 로그에 남긴다.
    // (worker 파일 누락처럼 배포 환경에서만 재현되는 문제를 추적하기 위함)
    console.error("PDF 텍스트 추출 실패:", error);
    return NextResponse.json(
      { message: "텍스트 추출이 불가능한 파일입니다" },
      { status: 422 },
    );
  }

  if (pages.length > MAX_PAGE_COUNT) {
    return NextResponse.json(
      { message: `최대 ${MAX_PAGE_COUNT}페이지까지의 PDF만 처리할 수 있습니다 (업로드한 파일: ${pages.length}페이지)` },
      { status: 400 },
    );
  }

  const totalTextLength = pages.reduce((sum, page) => sum + page.text.trim().length, 0);
  if (totalTextLength < MIN_EXTRACTED_TEXT_LENGTH) {
    // 스캔 이미지 등 글자를 거의 읽어오지 못한 경우
    return NextResponse.json(
      { message: "텍스트 추출이 불가능한 파일입니다" },
      { status: 422 },
    );
  }

  // DESIGN.md 흐름1 ②: 페이지 번호를 붙여서 보관 — 이후 요약·Q&A 단계에서
  // 답변 근거 페이지를 AI가 추측하지 않고 이 표시를 그대로 인용하게 한다.
  const pagedText = pages
    .map((page) => `[${page.num}페이지 본문] ${page.text.trim()}`)
    .join("\n\n");

  let summary: string;
  let detailedSummary: DetailedSummary;
  try {
    summary = await generateSummary(pagedText);
    detailedSummary = await generateDetailedSummary(pagedText);
  } catch {
    return NextResponse.json(
      { message: "일시적인 오류가 발생했습니다. 다시 시도해주세요" },
      { status: 502 },
    );
  }

  const pagesForClient = pages.map((page) => ({ num: page.num, text: page.text.trim() }));

  // 브라우저 식별용 세션 쿠키가 없으면 새로 발급. 새 논문 업로드이므로
  // 이전 대화 내역(chat_messages)은 비운다 (PRD 규칙: 한 세션에는 논문 한 편).
  const cookieHeader = request.headers.get("cookie") ?? "";
  const existingSessionId = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.split("=")[1];
  const sessionId = existingSessionId || randomUUID();

  const { error: dbError } = await supabaseAdmin.from("sessions").upsert({
    id: sessionId,
    filename: file.name,
    size: file.size,
    page_count: pages.length,
    pages: pagesForClient,
    full_text: pagedText,
    summary,
    detailed_summary: detailedSummary,
    chat_messages: [],
    updated_at: new Date().toISOString(),
  });

  if (dbError) {
    return NextResponse.json(
      { message: "일시적인 오류가 발생했습니다. 다시 시도해주세요" },
      { status: 502 },
    );
  }

  const response = NextResponse.json({
    filename: file.name,
    size: file.size,
    pageCount: pages.length,
    text: pagedText,
    // 화면에서 페이지별로 미리보기를 보여주기 위한 배열
    pages: pagesForClient,
    summary,
    detailedSummary,
  });

  response.cookies.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });

  return response;
}
