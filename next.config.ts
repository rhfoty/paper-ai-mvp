import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse(pdfjs-dist)는 번들링하지 않고 Node의 require로 그대로 불러와야
  // 서버에서 PDF 워커 파일 경로를 정상적으로 찾는다.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
