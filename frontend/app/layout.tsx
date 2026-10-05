import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "안 멈추는 길",
  description: "서울시 실측 통행시간 기반 경로와 카카오 경로를 비교합니다",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
