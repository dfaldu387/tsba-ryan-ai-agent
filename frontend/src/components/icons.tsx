// Small, theme-aware line icons (stroke: currentColor) shared across the console.
// Kept intentionally minimal — size them with CSS (width/height) at the call site.
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>
);

export const MailIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></Svg>
);

export const ResetIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 12a9 9 0 1 0 2.64-6.36" /><path d="M3 3v6h6" /></Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" /><path d="M10 11v6M14 11v6" /></Svg>
);

export const ExternalLinkIcon = (p: IconProps) => (
  <Svg {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></Svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>
);

export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" /><path d="m9 12 2 2 4-4" /></Svg>
);

// Audience icons
export const UserIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>
);

export const WrenchIcon = (p: IconProps) => (
  <Svg {...p}><path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4l-2.7 2.7-2-2z" /></Svg>
);

export const BriefcaseIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M3 13h18" /></Svg>
);

// Channel icons
export const ChatIcon = (p: IconProps) => (
  <Svg {...p}><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-8a8 8 0 0 1 8-8h2a8 8 0 0 1 8 5z" /></Svg>
);

export const TextIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M7 9h10M7 13h6" /></Svg>
);
