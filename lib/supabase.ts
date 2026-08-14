import { createClient } from "@supabase/supabase-js";

// 서버 전용 클라이언트. service role 키는 절대 클라이언트 번들에 노출되지 않는다
// (Route Handler 안에서만 사용, NEXT_PUBLIC_ 접두사 아님).
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
