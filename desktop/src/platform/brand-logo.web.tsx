export function FuzzyLogo({
  ariaLabel = "EcomBrain Teams",
  className,
}: {
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <img
      alt={ariaLabel}
      className={className}
      src="/teams/ecombrain-logo.png"
    />
  );
}
