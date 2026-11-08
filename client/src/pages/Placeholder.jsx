// A simple page with a title and a short message. Used for pages that are not built yet.
export default function Placeholder({ title, children }) {
  return (
    <main className="page-view">
      <h1 className="page-h1">{title}</h1>
      <div className="card">{children}</div>
    </main>
  );
}
