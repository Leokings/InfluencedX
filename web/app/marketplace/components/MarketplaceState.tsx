import Link from "next/link";

export function MarketplaceState({
  kind,
  title,
  message,
  action,
  onRetry,
}: {
  kind: "loading" | "empty" | "error";
  title: string;
  message: string;
  action?: { href: string; label: string };
  onRetry?: () => void;
}) {
  return (
    <div className={`marketplace-state ${kind}`} role={kind === "error" ? "alert" : "status"} aria-live="polite">
      <span>{kind.toUpperCase()}</span>
      <h3>{title}</h3>
      <p>{message}</p>
      {action ? <Link className="button" href={action.href}>{action.label} →</Link> : null}
      {onRetry ? <button className="verify-secondary" type="button" onClick={onRetry}>RETRY</button> : null}
    </div>
  );
}
