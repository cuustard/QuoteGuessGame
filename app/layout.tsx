import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Who Said It?",
  description: "The party quote guessing game",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
