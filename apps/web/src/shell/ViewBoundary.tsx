import { Component, type ReactNode } from 'react';

/** Keep navigation and a user's draft usable when a separately loaded view fails. */
export class ViewBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    if (this.state.error) return <div className="canvas-view-error" role="alert">
      <h2>This view could not be opened.</h2>
      <p>Your research is still stored on the server. You can return home or reload this view.</p>
      <div><a className="btn" href="#/">Return home</a> <button className="btn" onClick={() => window.location.reload()}>Reload</button></div>
    </div>;
    return this.props.children;
  }
}
