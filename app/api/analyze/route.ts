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
2. 응답은 450자 이내의 한국어로 작성하고, 반드시 문장을 완결해서 끝낸다. (화면에는 500자까지만 표시되므로 450자를 넘기면 문장이 잘린다.)
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
  // 모델이 글자 수 지시를 넘길 경우를 대비한 최종 안전장치.
  // 그냥 자르면 문장 중간이 끊겨서("...이루어진 점" 처럼) 읽기 어려우므로
  // 500자 안에서 마지막으로 완결된 문장까지만 남긴다.
  return trimToSentenceBoundary(summary, SUMMARY_MAX_LENGTH);
}

function trimToSentenceBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const cut = text.slice(0, maxLength);
  const lastSentenceEnd = Math.max(
    cut.lastIndexOf("."),
    cut.lastIndexOf("!"),
    cut.lastIndexOf("?"),
  );

  // 문장 끝을 너무 앞에서 찾으면 내용이 과하게 날아가므로, 그럴 때는 그대로 자른다.
  return lastSentenceEnd > maxLength / 2 ? cut.slice(0, lastSentenceEnd + 1) : cut;
}

export type DetailedSummary = {
  keyTerms: string;
  motivation: string;
  methodResults: string;
  conclusion: string;
};

// DESIGN.md 흐름1 ⑤: 500자 핵심 요약과 별도로 4단계 상세 요약을 생성한다.
// 주의: 4개 항목을 JSON 하나로 한 번에 받으면, keyTerms가 길어질 때 나머지 3개 항목이
// 빈 문자열로 밀려나는 현상을 실제로 확인했다(finish_reason은 stop, 잘림이 아님).
// 그래서 항목별로 호출을 분리해 병렬 실행한다. 각 항목이 토큰 예산을 온전히 쓰므로
// 더 길고 깊게 나오고, 한 항목이 다른 항목을 굶기는 일도 없다.
const DETAILED_COMMON_RULES = `당신은 생명공학·의약학 분야 대학원생을 돕는 논문 요약 도우미입니다.
사용자 메시지로 페이지 번호가 붙은 논문 전문이 주어집니다.
반드시 지켜야 할 규칙:
1. 논문 텍스트에 없는 내용은 절대 추측해서 넣지 않는다 (환각 금지). 논문에 해당 정보가 없으면 "논문에서 확인할 수 없습니다"라고만 쓴다. 근거가 없는 내용으로 분량을 늘리는 것은 절대 금지다.
2. 핵심 기술 용어·지표·약어·포맷 명칭은 한국어로 번역하지 않고 영어 원문 그대로 사용하고, 문장 구조만 자연스러운 한국어로 작성한다.
3. 글자 수 제한은 없다. 대학원 랩미팅 발표 자료로 바로 쓸 수 있을 만큼 깊이 있고 전문적으로, 충분히 길게 쓴다. 논문에 근거가 있는 내용은 뭉개지 말고 구체적인 수치·조건·실험 설계까지 살린다.
4. 제목이나 머리말을 붙이지 않고 본문만 쓴다. 마크다운 기호(**, ##, - 등)는 쓰지 않고 평문으로 쓴다.
5. 문단을 나눌 때는 빈 줄로 구분한다.`;

const DETAILED_SECTION_INSTRUCTIONS: Record<keyof DetailedSummary, string> = {
  keyTerms: `이 논문을 이해하는 데 꼭 필요한 약어·포맷·기술적 개념을 5~8가지 선정해 정리하라.
반드시 한 용어를 한 덩어리로 쓰고, 용어와 용어 사이는 빈 줄로 구분해 눈으로 바로 구분되게 한다.
각 덩어리는 "용어 (풀네임): 정의" 형식으로 시작한다.
정의는 일반적인 뜻에서 그치지 말고, 이 논문에서 그 용어가 어떤 역할을 하는지까지 2~3문장으로 설명한다.
용어 이름과 기술 용어만 영어로 남기고, 정의를 설명하는 문장은 반드시 한국어로 작성한다. 논문이 영어로 쓰였다고 해서 정의를 영어로 쓰지 않는다.`,
  motivation: `저자들이 해결하려는 핵심 문제가 무엇인지 서술하라.
기존 연구(Baseline)의 구체적인 한계를 수치와 함께 짚고, 그 한계가 왜 문제인지 설명한다.
이 연구가 그 공백을 어떻게 겨냥하는지까지 이어서 쓴다.
논문에 근거가 충분하다면 2문단 이상으로 나눠 쓴다.`,
  methodResults: `제안 방법론의 동작 원리를 단계적으로 설명하라.
이어서 실험 설계(대상·조건·반복 횟수·통계 처리 등)를 구체적으로 밝히고,
주요 결과를 구체적인 수치와 Baseline 대비 비교 우위 중심으로 서술한다.
논문이 스스로 밝힌 한계나 실패 사례, 대조군 결과도 있으면 함께 쓴다.
논문에 근거가 충분하다면 2문단 이상으로 나눠 쓴다.`,
  conclusion: `논문의 결론을 서술하라.
그 결론이 해당 분야(학계 또는 산업계)에 갖는 의미를 설명하고,
후속 연구나 실제 응용으로 이어질 수 있는 지점까지 쓴다.
논문이 밝힌 한계가 향후 과제와 연결된다면 그것도 함께 다룬다.
논문에 근거가 충분하다면 2문단 이상으로 나눠 쓴다.`,
};

async function generateSection(
  instruction: string,
  pagedText: string,
): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: `${DETAILED_COMMON_RULES}\n\n[이번에 작성할 항목]\n${instruction}` },
      { role: "user", content: pagedText },
    ],
    max_tokens: 2000,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
}

async function generateDetailedSummary(pagedText: string): Promise<DetailedSummary> {
  const [keyTerms, motivation, methodResults, conclusion] = await Promise.all([
    generateSection(DETAILED_SECTION_INSTRUCTIONS.keyTerms, pagedText),
    generateSection(DETAILED_SECTION_INSTRUCTIONS.motivation, pagedText),
    generateSection(DETAILED_SECTION_INSTRUCTIONS.methodResults, pagedText),
    generateSection(DETAILED_SECTION_INSTRUCTIONS.conclusion, pagedText),
  ]);

  return { keyTerms, motivation, methodResults, conclusion };
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
