type IconProps = {
  className?: string;
};

function iconClass(name: string, className?: string) {
  return `ui-icon ui-icon-${name}${className ? ` ${className}` : ""}`;
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg
      className={iconClass("external", className)}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 12.5 12.5 3.5M7 3.5h5.5V9" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return <span className={iconClass("play", className)} aria-hidden="true" />;
}

export function CloseIcon({ className }: IconProps) {
  return <span className={iconClass("close", className)} aria-hidden="true" />;
}

export function StarIcon({ className }: IconProps) {
  return <span className={iconClass("star", className)} aria-hidden="true" />;
}
