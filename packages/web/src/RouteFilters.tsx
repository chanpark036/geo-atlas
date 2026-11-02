import type { CSSProperties } from 'react';
import type { Catalog } from '@geoatlas/adapter-core';
interface Props {
  catalog: Catalog;
  hidden: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}
export function RouteFilters({ catalog, hidden, onChange }: Props) {
  return (
    <div className="route-filters">
      <div className="route-filter-actions">
        <span>
          {catalog.routes.length - hidden.size} / {catalog.routes.length} routes
        </span>
        <button onClick={() => onChange(new Set())}>All</button>
        <button onClick={() => onChange(new Set(catalog.routes.map((route) => route.id)))}>
          None
        </button>
      </div>
      <div className="route-grid">
        {catalog.routes.map((route) => (
          <button
            key={route.id}
            className="route-toggle"
            style={{ '--route-color': route.color } as CSSProperties}
            title={route.name}
            aria-label={`${route.id}: ${route.name}`}
            aria-pressed={!hidden.has(route.id)}
            onClick={() => {
              const next = new Set(hidden);
              if (next.has(route.id)) next.delete(route.id);
              else next.add(route.id);
              onChange(next);
            }}
          >
            {route.id}
          </button>
        ))}
      </div>
      <small className="route-filter-note">No reports may mean no service or a delayed feed.</small>
    </div>
  );
}
