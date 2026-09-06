/** The Jewel POS mark: a brilliant-cut stone in the shop's copper.
 *
 * Inline SVG rather than an <img> so it inherits crisply at any DPI and needs
 * no asset round-trip. Kept in step with resources/logo.svg, which generates
 * the app and tray icons. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Jewel POS"
      style={{ display: 'block', flex: 'none' }}
    >
      <g transform="translate(16 17.5)">
        <path d="M-13.5-3 L13.5-3 L0 13.5 Z" fill="#b2622d" />
        <path d="M-13.5-3 L-8-11 L8-11 L13.5-3 Z" fill="#d67f48" />
        <path d="M-8-11 L8-11 L5-3 L-5-3 Z" fill="#ffe1d0" />
        <path
          d="M-5-3 L0 13.5 L5-3"
          fill="none"
          stroke="#5c3413"
          strokeWidth="1.1"
          strokeOpacity=".5"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
