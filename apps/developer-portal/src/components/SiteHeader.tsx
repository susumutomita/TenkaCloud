"use client";

import { useState } from "react";
import { PRIMARY_NAV } from "@/lib/navigation";
import { BrandMark } from "./BrandMark";
import { CommandSearch } from "./CommandSearch";
import { HeaderLangSwitch } from "./HeaderLangSwitch";

// The app shell renders one global header around every
// route — landing, docs, and the Scalar API reference alike — from the single
// PRIMARY_NAV model. The mobile toggle reveals the same links on small screens.
export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="site-header__brand" href="/">
          <BrandMark size={22} className="site-header__mark" />
          <span>TenkaCloud</span>
        </a>
        <nav className="site-header__nav" aria-label="Primary">
          {PRIMARY_NAV.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <span className="site-header__spacer" />
        <HeaderLangSwitch />
        <CommandSearch />
        <button
          type="button"
          className="mobile-nav-toggle"
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
          aria-label="Toggle navigation menu"
          onClick={() => setMobileOpen((value) => !value)}
        >
          Menu
        </button>
      </div>
      {mobileOpen ? (
        <nav id="mobile-nav" className="mobile-nav" aria-label="Mobile">
          <ul>
            {PRIMARY_NAV.map((link) => (
              <li key={link.href}>
                <a href={link.href} onClick={() => setMobileOpen(false)}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
