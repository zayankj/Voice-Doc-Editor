// Decorative ruler above the page (same width as the page)
export default function Ruler() {
  return (
    <div className="ruler">
      <div className="ruler-inner">
        <span className="mark left" />
        <span className="mark right" />
      </div>
    </div>
  );
}