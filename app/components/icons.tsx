type IconProps = {
  className?: string;
};

function iconClass(name: string, className?: string) {
  return `ui-icon ui-icon-${name}${className ? ` ${className}` : ""}`;
}

export function ExternalLinkIcon({ className }: IconProps) {
  return <span className={iconClass("external", className)} aria-hidden="true" />;
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
