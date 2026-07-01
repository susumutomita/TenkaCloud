import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  // The unified developer platform is served from the site root (ADR-0003). Absolute
  // URLs (OpenGraph, canonical) resolve against this base.
  metadataBase: new URL("https://tenkacloud.com"),
  title: {
    default: "TenkaCloud Developer Platform",
    template: "%s · TenkaCloud",
  },
  description:
    "One developer platform for TenkaCloud: product, docs, API reference, examples, and changelog under one shell.",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: "TenkaCloud",
    images: ["/og-image.png"],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og-image.png"],
  },
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
