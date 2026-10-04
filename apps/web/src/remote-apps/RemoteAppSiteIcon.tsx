import type { RemoteAppSite } from "@t3tools/contracts";
import { ClaudeAI, GrokIcon, OpenAI, type Icon } from "~/components/Icons";

// Gemini has no mark in the shared icon set; this is its four-point sparkle.
const GeminiIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <linearGradient
        id="remote-app-gemini-mark"
        x1="0"
        y1="24"
        x2="24"
        y2="0"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#4f8df5" />
        <stop offset="0.55" stopColor="#9b72cb" />
        <stop offset="1" stopColor="#d96570" />
      </linearGradient>
    </defs>
    <path
      fill="url(#remote-app-gemini-mark)"
      d="M12 0C12 6.627 17.373 12 24 12C17.373 12 12 17.373 12 24C12 17.373 6.627 12 0 12C6.627 12 12 6.627 12 0Z"
    />
  </svg>
);

const SITE_ICONS: Record<RemoteAppSite, Icon> = {
  chatgpt: OpenAI,
  claude: ClaudeAI,
  grok: GrokIcon,
  gemini: GeminiIcon,
};

export function RemoteAppSiteIcon({
  site,
  className,
}: {
  readonly site: RemoteAppSite;
  readonly className?: string;
}) {
  const SiteIcon = SITE_ICONS[site];
  return <SiteIcon aria-hidden="true" className={className} />;
}
