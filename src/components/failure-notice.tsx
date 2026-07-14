import type { UserFacingFailure } from "../../shared/failure";
import { cn } from "../lib/utils";

export function FailureNotice({
  failure,
  compact = false,
  warning = false,
}: {
  failure: UserFacingFailure;
  compact?: boolean;
  warning?: boolean;
}) {
  const text = [
    failure.message,
    failure.action,
    failure.reference ? `Reference: ${failure.reference}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const className = cn(
    "leading-5",
    compact ? "max-w-xl text-xs" : "text-sm",
    warning ? "text-amber-400" : "text-red-400",
  );
  const content = (
    <>
      <span>{failure.message}</span>
      {failure.action ? <span className="text-current/80"> {failure.action}</span> : null}
      {failure.reference ? (
        <span className="font-mono text-[0.6875rem] text-current/65">
          {" "}
          Reference: {failure.reference}
        </span>
      ) : null}
    </>
  );

  if (compact) {
    return (
      <span className={className} title={text}>
        {content}
      </span>
    );
  }

  return (
    <p className={className} role="alert" title={text}>
      {content}
    </p>
  );
}
