import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tripwire",
  description:
    "Tripwire checks every transaction before it executes — spending limits, a cooling-off delay, or an emergency freeze, configured in plain English.",
  openGraph: {
    type: "website",
    title:
      "Tripwire",
    description:
      "Tripwire checks every transaction before it executes — spending limits, a cooling-off delay, or an emergency freeze, configured in plain English.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} antialiased bg-theme-dark`}>
        {children}
      </body>
    </html>
  );
}
