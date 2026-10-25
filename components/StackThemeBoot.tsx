const STACK_THEME_VARS = {
  midnight: {
    "--stack-theme-bg": "radial-gradient(circle at top left, rgba(59,130,246,0.18), transparent 32%), radial-gradient(circle at top right, rgba(148,163,184,0.10), transparent 30%), #05070d",
    "--stack-theme-fg": "#e5e7eb",
    "--stack-theme-surface": "rgba(12, 18, 32, 0.78)",
    "--stack-theme-accent": "linear-gradient(135deg, rgba(37,99,235,0.28), rgba(17,24,39,0.78))",
    "--stack-theme-good": "rgba(16,185,129,0.22)",
    "--stack-theme-good-border": "rgba(16,185,129,0.35)",
    "--stack-theme-bad": "rgba(239,68,68,0.18)",
    "--stack-theme-bad-border": "rgba(239,68,68,0.32)",
    "--stack-theme-focus": "#64748b",
    "--stack-theme-ring": "rgba(255,255,255,0.10)",
  },
  ocean: {
    "--stack-theme-bg": "radial-gradient(circle at top left, rgba(34,211,238,0.20), transparent 34%), radial-gradient(circle at bottom right, rgba(59,130,246,0.18), transparent 30%), #031018",
    "--stack-theme-fg": "#e6fbff",
    "--stack-theme-surface": "rgba(6, 25, 38, 0.78)",
    "--stack-theme-accent": "linear-gradient(135deg, rgba(14,165,233,0.32), rgba(8,47,73,0.76))",
    "--stack-theme-good": "rgba(34,211,238,0.18)",
    "--stack-theme-good-border": "rgba(34,211,238,0.35)",
    "--stack-theme-bad": "rgba(244,63,94,0.18)",
    "--stack-theme-bad-border": "rgba(244,63,94,0.32)",
    "--stack-theme-focus": "#22d3ee",
    "--stack-theme-ring": "rgba(34,211,238,0.12)",
  },
  emerald: {
    "--stack-theme-bg": "radial-gradient(circle at top left, rgba(16,185,129,0.20), transparent 34%), radial-gradient(circle at bottom right, rgba(20,184,166,0.14), transparent 32%), #04120d",
    "--stack-theme-fg": "#ecfdf5",
    "--stack-theme-surface": "rgba(5, 30, 22, 0.78)",
    "--stack-theme-accent": "linear-gradient(135deg, rgba(16,185,129,0.30), rgba(6,78,59,0.75))",
    "--stack-theme-good": "rgba(16,185,129,0.24)",
    "--stack-theme-good-border": "rgba(16,185,129,0.40)",
    "--stack-theme-bad": "rgba(248,113,113,0.18)",
    "--stack-theme-bad-border": "rgba(248,113,113,0.32)",
    "--stack-theme-focus": "#10b981",
    "--stack-theme-ring": "rgba(16,185,129,0.12)",
  },
  violet: {
    "--stack-theme-bg": "radial-gradient(circle at top left, rgba(167,139,250,0.22), transparent 34%), radial-gradient(circle at bottom right, rgba(236,72,153,0.12), transparent 32%), #0b0714",
    "--stack-theme-fg": "#f5f3ff",
    "--stack-theme-surface": "rgba(27, 15, 49, 0.78)",
    "--stack-theme-accent": "linear-gradient(135deg, rgba(124,58,237,0.34), rgba(49,46,129,0.72))",
    "--stack-theme-good": "rgba(168,85,247,0.22)",
    "--stack-theme-good-border": "rgba(168,85,247,0.38)",
    "--stack-theme-bad": "rgba(244,63,94,0.18)",
    "--stack-theme-bad-border": "rgba(244,63,94,0.32)",
    "--stack-theme-focus": "#a78bfa",
    "--stack-theme-ring": "rgba(167,139,250,0.14)",
  },
  rose: {
    "--stack-theme-bg": "radial-gradient(circle at top left, rgba(244,63,94,0.20), transparent 34%), radial-gradient(circle at bottom right, rgba(251,113,133,0.14), transparent 32%), #14070b",
    "--stack-theme-fg": "#fff1f2",
    "--stack-theme-surface": "rgba(42, 13, 22, 0.78)",
    "--stack-theme-accent": "linear-gradient(135deg, rgba(225,29,72,0.32), rgba(76,5,25,0.74))",
    "--stack-theme-good": "rgba(244,63,94,0.20)",
    "--stack-theme-good-border": "rgba(244,63,94,0.36)",
    "--stack-theme-bad": "rgba(239,68,68,0.20)",
    "--stack-theme-bad-border": "rgba(239,68,68,0.34)",
    "--stack-theme-focus": "#fb7185",
    "--stack-theme-ring": "rgba(244,63,94,0.13)",
  },
  amber: {
    "--stack-theme-bg": "radial-gradient(circle at top left, rgba(245,158,11,0.20), transparent 34%), radial-gradient(circle at bottom right, rgba(217,119,6,0.14), transparent 32%), #120b03",
    "--stack-theme-fg": "#fffbeb",
    "--stack-theme-surface": "rgba(37, 24, 8, 0.78)",
    "--stack-theme-accent": "linear-gradient(135deg, rgba(217,119,6,0.30), rgba(69,26,3,0.74))",
    "--stack-theme-good": "rgba(245,158,11,0.22)",
    "--stack-theme-good-border": "rgba(245,158,11,0.38)",
    "--stack-theme-bad": "rgba(239,68,68,0.18)",
    "--stack-theme-bad-border": "rgba(239,68,68,0.32)",
    "--stack-theme-focus": "#f59e0b",
    "--stack-theme-ring": "rgba(245,158,11,0.13)",
  },
} as const;

const STACK_THEME_BOOT_SCRIPT = `(function(){try{var themes=${JSON.stringify(
  STACK_THEME_VARS
).replace(/</g, "\\u003c")};var theme=null;try{theme=localStorage.getItem("stack-color-theme-v1");}catch(e){}if(!themes[theme]){try{var match=document.cookie.match(/(?:^|; )stack_color_theme=([^;]+)/);theme=match?decodeURIComponent(match[1]):null;}catch(e){}}if(!themes[theme])theme="midnight";var root=document.documentElement;var vars=themes[theme];Object.keys(vars).forEach(function(k){root.style.setProperty(k,vars[k]);});root.dataset.stackTheme=theme;root.style.colorScheme="dark";var bg="";try{bg=String(localStorage.getItem("stack-background-image-v1")||"").trim();}catch(e){}if(!bg){try{var bgMatch=document.cookie.match(/(?:^|; )stack_background_image=([^;]+)/);bg=bgMatch?decodeURIComponent(bgMatch[1]).trim():"";}catch(e){}}if(bg){var cssUrl=JSON.stringify(bg);var overlay="linear-gradient(rgba(3, 6, 14, 0.76), rgba(3, 6, 14, 0.90))";root.style.setProperty("--stack-custom-background",overlay+", url("+cssUrl+") center / cover fixed, linear-gradient(#03060e, #03060e)");root.style.backgroundColor="#03060e";root.style.backgroundImage=overlay+", url("+cssUrl+")";root.style.backgroundPosition="center, center";root.style.backgroundSize="cover, cover";root.style.backgroundRepeat="no-repeat, no-repeat";root.style.backgroundAttachment="fixed, fixed";root.dataset.stackCustomBackground="1";try{var preload=document.createElement("link");preload.rel="preload";preload.as="image";preload.href=bg;preload.setAttribute("fetchpriority","high");document.head.appendChild(preload);}catch(e){}}else{root.style.removeProperty("--stack-custom-background");root.style.removeProperty("background-color");root.style.removeProperty("background-image");root.style.removeProperty("background-position");root.style.removeProperty("background-size");root.style.removeProperty("background-repeat");root.style.removeProperty("background-attachment");try{delete root.dataset.stackCustomBackground;}catch(e){}}var banner="";try{banner=String(localStorage.getItem("stack-banner-image-v1")||"").trim();}catch(e){}if(!banner){try{var bannerMatch=document.cookie.match(/(?:^|; )stack_banner_image=([^;]+)/);banner=bannerMatch?decodeURIComponent(bannerMatch[1]).trim():"";}catch(e){}}if(banner){var bannerCssUrl=JSON.stringify(banner);root.style.setProperty("--stack-custom-banner-image","url("+bannerCssUrl+")");root.style.setProperty("--stack-custom-banner-base","#03060e");root.dataset.stackCustomBanner="1";try{var bannerPreload=document.createElement("link");bannerPreload.rel="preload";bannerPreload.as="image";bannerPreload.href=banner;bannerPreload.setAttribute("fetchpriority","high");bannerPreload.setAttribute("data-stack-banner-preload","1");document.head.appendChild(bannerPreload);}catch(e){}}else{root.style.removeProperty("--stack-custom-banner-image");root.style.removeProperty("--stack-custom-banner-base");try{delete root.dataset.stackCustomBanner;}catch(e){}}}catch(e){}})();`

export default function StackThemeBoot() {
  return (
    <script
      id="stack-theme-boot"
      dangerouslySetInnerHTML={{ __html: STACK_THEME_BOOT_SCRIPT }}
    />
  );
}
