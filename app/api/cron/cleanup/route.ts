import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/session";

// PRD 규칙: 96시간이 지난 논문·요약·대화는 자동 삭제한다.
// Vercel Cron Jobs가 이 경로를 정기 호출한다 (vercel.json 참고).
// Vercel은 호출 시 Authorization: Bearer $CRON_SECRET 헤더를 자동으로 붙여주므로,
// 이 값을 검증해 외부에서 임의로 삭제 API를 호출하지 못하게 막는다.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: "권한이 없습니다" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - SESSION_MAX_AGE_SECONDS * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("sessions")
    .delete()
    .lt("updated_at", cutoff)
    .select("id");

  if (error) {
    return NextResponse.json(
      { message: "일시적인 오류가 발생했습니다. 다시 시도해주세요" },
      { status: 502 },
    );
  }

  return NextResponse.json({ deletedCount: data?.length ?? 0 });
}
