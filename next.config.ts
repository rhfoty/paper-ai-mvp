import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse(pdfjs-dist)는 번들링하지 않고 Node의 require로 그대로 불러와야
  // 서버에서 PDF 워커 파일 경로를 정상적으로 찾는다.
  serverExternalPackages: ["pdf-parse"],
  // pdfjs-dist는 Node 환경에서 DOMMatrix 같은 DOM 타입을 @napi-rs/canvas로 폴리필한다.
  // 이 require가 try/catch 안의 동적 호출이라 Next.js 파일 트레이싱이 감지하지 못하고,
  // 배포 함수에서 빠지면 모듈 로드 시점에 "DOMMatrix is not defined"로 죽는다.
  // (로컬은 node_modules가 그대로 있어서 문제가 드러나지 않는다.)
  // 따라서 해당 네이티브 패키지를 트레이스에 강제로 포함시킨다.
  // 같은 이유로 pdfjs-dist의 worker 파일(pdf.worker.mjs)과 폰트/cmap 리소스도
  // 동적으로 경로를 만들어 불러오기 때문에 트레이싱에서 빠진다. 빠지면 배포 환경에서만
  // PDF 파싱이 실패해 "텍스트 추출이 불가능한 파일입니다"로 잘못 안내된다.
  outputFileTracingIncludes: {
    "/api/analyze": [
      "node_modules/@napi-rs/canvas/**/*",
      "node_modules/@napi-rs/canvas-linux-*/**/*",
      "node_modules/pdfjs-dist/legacy/build/**/*",
      "node_modules/pdfjs-dist/standard_fonts/**/*",
      "node_modules/pdfjs-dist/cmaps/**/*",
      "node_modules/pdf-parse/dist/**/*",
    ],
  },
};

export default nextConfig;
