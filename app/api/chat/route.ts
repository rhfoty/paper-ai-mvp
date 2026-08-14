import { NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin } from "@/lib/supabase";
import { SESSION_COOKIE_NAME } from "@/lib/session";

// 질문 하나가 지나치게 길어지는 것을 막기 위한 상한값
const MAX_QUESTION_LENGTH = 1000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// PRD/DESIGN 공통 AI 규칙 + Q&A 3분기 답변 규칙(PLAN 9)
// 페이지 번호는 답변 문장에 섞지 않고 별도 pages 배열로 받아, 화면에서 배지 UI로 분리 표시한다(PLAN 10).
const CHAT_SYSTEM_PROMPT = `당신은 생명공학·의약학 분야 대학원생을 돕는 논문 Q&A 도우미입니다.
사용자 메시지에는 [질문]과, 페이지 번호가 붙은 [논문 전체 텍스트]가 함께 주어집니다.
반드시 아래 3가지 상황 중 정확히 하나에 해당하는 방식으로 answer 필드를 작성하세요:
1. 질문의 근거가 [논문 전체 텍스트] 안에 있다면, 그 내용을 바탕으로 answer를 작성하고, 근거로 사용한 페이지 번호를 pages 배열에 넣는다.
2. 질문이 논문에 등장하는 개념이지만 논문 자체에는 자세히 설명되어 있지 않다면, answer를 일반 지식으로 작성하되 끝에 반드시 "이 내용은 논문에 없는 일반 지식입니다"를 그대로 덧붙이고, pages는 빈 배열로 둔다.
3. 질문이 논문 내용과 전혀 관련이 없다면, answer에 다른 설명 없이 정확히 "논문과 관련된 질문만 답변할 수 있습니다"라고만 쓰고, pages는 빈 배열로 둔다.
그 외 규칙:
- answer 문장 안에는 "(N페이지 참고)" 같은 페이지 번호 표시를 넣지 않는다. 페이지 번호는 pages 배열로만 전달한다.
- [논문 전체 텍스트]에 없는 내용을 추측해서 answer에 추가하지 않는다 (환각 금지).
- 핵심 기술 용어·지표·약어·포맷 명칭은 한국어로 번역하지 않고 영어 원문 그대로 사용하고, 문장 구조만 자연스러운 한국어로 작성한다.
- 다른 설명 없이 아래 형식의 JSON 객체 하나만 응답한다: {"answer": string, "pages": number[]}`;

type ChatAnswer = { answer: string; pages: number[] };

async function generateChatAnswer(question: string, paperText: string): Promise<ChatAnswer> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      { role: "user", content: `[질문]\n${question}\n\n[논문 전체 텍스트]\n${paperText}` },
    ],
    max_tokens: 700,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Partial<ChatAnswer>;

  return {
    answer: parsed.answer ?? "",
    pages: Array.isArray(parsed.pages) ? parsed.pages.filter((n) => typeof n === "number") : [],
  };
}

export async function POST(request: Request) {
  let body: { question?: unknown; paperText?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { message: "일시적인 오류가 발생했습니다. 다시 시도해주세요" },
      { status: 400 },
    );
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const paperText = typeof body.paperText === "string" ? body.paperText : "";

  if (!question || question.length > MAX_QUESTION_LENGTH || !paperText) {
    return NextResponse.json(
      { message: "질문 내용을 확인해주세요" },
      { status: 400 },
    );
  }

  let result: ChatAnswer;
  try {
    result = await generateChatAnswer(question, paperText);
  } catch {
    return NextResponse.json(
      { message: "일시적인 오류가 발생했습니다. 다시 시도해주세요" },
      { status: 502 },
    );
  }

  // 세션에 저장된 논문이 있으면 대화 내역도 함께 저장 (96시간 재접속 시 이어보기 대비, PLAN 14)
  const cookieHeader = request.headers.get("cookie") ?? "";
  const sessionId = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.split("=")[1];

  if (sessionId) {
    const { data: session } = await supabaseAdmin
      .from("sessions")
      .select("chat_messages")
      .eq("id", sessionId)
      .maybeSingle();

    if (session) {
      const chatMessages = Array.isArray(session.chat_messages) ? session.chat_messages : [];
      chatMessages.push({ role: "user", content: question });
      chatMessages.push({ role: "assistant", content: result.answer, pages: result.pages });

      await supabaseAdmin
        .from("sessions")
        .update({ chat_messages: chatMessages, updated_at: new Date().toISOString() })
        .eq("id", sessionId);
    }
  }

  return NextResponse.json(result);
}
