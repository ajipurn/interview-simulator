import type { Metadata } from "next";
import { Press_Start_2P, VT323 } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// game fonts: 8-bit display for headings/buttons/HUD, readable retro mono for text
const display = Press_Start_2P({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const body = VT323({ weight: "400", subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Interview Simulator",
  description: "Latihan wawancara kerja dalam kantor 3D dengan AI interviewer bersuara.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
