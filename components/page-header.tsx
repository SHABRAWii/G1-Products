import { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, action, tabs }: { eyebrow?: string; title: string; description: string; action?: ReactNode; tabs?: string[] }) {
  return (
    <div className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        <p className="page-header__description">{description}</p>
      </div>
      {action ? <div className="page-header__action">{action}</div> : null}
      {tabs ? <nav className="page-tabs" aria-label={`${title} sections`}>{tabs.map((tab, index) => <button className={index === 0 ? "page-tabs__active" : ""} key={tab}>{tab}</button>)}</nav> : null}
    </div>
  );
}
