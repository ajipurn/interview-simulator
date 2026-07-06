import type { Metadata, Viewport } from "next";
import { Press_Start_2P, VT323 } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// game fonts: 8-bit display for headings/buttons/HUD, readable retro mono for text
const display = Press_Start_2P({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const body = VT323({ weight: "400", subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Interview Simulator",
  description: "Latihan wawancara kerja dalam kantor 3D dengan AI interviewer bersuara.",
  icons: { icon: "/brand.svg" },
};

// game viewport: no pinch/double-tap zoom fighting the camera controls
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
