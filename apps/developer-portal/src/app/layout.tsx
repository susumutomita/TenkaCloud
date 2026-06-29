import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "TenkaCloud Developer Platform",
    template: "%s · TenkaCloud",
  },
  description:
    "One developer platform for TenkaCloud: product, docs, API reference, examples, and changelog under one shell.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
