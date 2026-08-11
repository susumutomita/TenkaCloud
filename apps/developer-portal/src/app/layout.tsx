import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  // The developer portal is served from the site root. Absolute
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
      <head>
        {/* Legacy landing type stack: Inter + Noto Sans JP (sans) + JetBrains Mono
            (mono), loaded via Google Fonts the same way landing/index.html did. A
            runtime <link> keeps the static export build self-contained (no build-time
            font fetch) and there is no CSP header blocking fonts.googleapis.com. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Noto+Sans+JP:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
