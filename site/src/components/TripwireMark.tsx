import {
  MARK_NODE,
  MARK_STROKES,
  MARK_VIEWBOX,
} from "../../../shared/tripwireMark";

/**
 * The Tripwire mark. The geometry is shared with the dashboard — see
 * shared/tripwireMark.ts — and rendered here so it keeps `currentColor` and
 * takes the colour of whatever it sits in.
 */
export default function TripwireMark({
  className,
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      {MARK_STROKES.map((d) => (
        <path key={d} d={d} />
      ))}
      <circle {...MARK_NODE} fill="currentColor" stroke="none" />
    </svg>
  );
}
