import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/session";

// PRD 규칙: 96시간 이내 재접속이면 이전 논문·요약·대화를 이어서 보여준다.
// 실제 삭제(PLAN 15)와 별개로, 여기서도 96시간이 지난 데이터는 "없음"으로 취급해
// 삭제 작업이 아직 돌기 전이라도 화면에는 만료된 데이터가 보이지 않게 한다.
export async function GET(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const sessionId = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.split("=")[1];

  if (!sessionId) {
    return NextResponse.json({ exists: false });
  }

  const { data: session } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session) {
    return NextResponse.json({ exists: false });
  }

  const updatedAt = new Date(session.updated_at).getTime();
  const isExpired = Date.now() - updatedAt > SESSION_MAX_AGE_SECONDS * 1000;
  if (isExpired) {
    return NextResponse.json({ exists: false });
  }

  return NextResponse.json({
    exists: true,
    filename: session.filename,
    size: session.size,
    pageCount: session.page_count,
    text: session.full_text,
    pages: session.pages,
    summary: session.summary,
    detailedSummary: session.detailed_summary,
    chatMessages: session.chat_messages ?? [],
  });
}
