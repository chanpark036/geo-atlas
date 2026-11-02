import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  catalogSchema,
  dashboardStatusSchema,
  type Catalog,
  type DashboardStatus,
  type TrackedEntity,
} from '@geoatlas/adapter-core';
import { connectLive, type Connection } from './live';
import { MapView } from './MapView';
import { reportPresentation } from './report-presentation';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

const age = (timestamp: string, now: number) => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
};
const label = (entity: TrackedEntity) => String(entity.properties.label ?? entity.id);

function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [entities, setEntities] = useState<TrackedEntity[]>([]);
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [resetToken, setResetToken] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [trains, setTrains] = useState(true);
  const [ships, setShips] = useState(true);
  const [search, setSearch] = useState('');
  const [sources, setSources] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/catalog', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((value) => setCatalog(catalogSchema.parse(value)))
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch('/api/status', {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) throw new Error();
        const next = dashboardStatusSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setStatus(next);
          setStatusError(false);
        }
      } catch {
        if (!controller.signal.aborted) setStatusError(true);
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(load, 5_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  useEffect(
    () =>
      connectLive((next, snapshot) => {
        setEntities(next);
        if (snapshot) setResetToken((value) => value + 1);
      }, setConnection),
    [],
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const displayEntities = useMemo(
    () =>
      entities.map((entity) => {
        const manifest = status?.manifests.find((item) => item.id === entity.adapterId);
        return {
          ...entity,
          stale:
            entity.stale ||
            (manifest !== undefined &&
              now - Date.parse(entity.observedAt) >= manifest.staleAfterMs),
        };
      }),
    [entities, status, now],
  );
  const visible = useMemo(
    () => displayEntities.filter((entity) => (entity.layer === 'subway' ? trains : ships)),
    [displayEntities, trains, ships],
  );
  const listed = useMemo(
    () =>
      visible
        .filter((entity) =>
          `${label(entity)} ${entity.properties.stop ?? ''} ${entity.id}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .sort((a, b) => label(a).localeCompare(label(b))),
    [visible, search],
  );
  useEffect(() => {
    if (!visible.some((entity) => entity.key === selected)) setSelected(visible[0]?.key ?? null);
  }, [visible, selected]);
  const entity = displayEntities.find((item) => item.key === selected);
  const route = catalog?.routes.find((item) => item.id === entity?.properties.route);
  const mode =
    status?.mode ?? (entities.some((item) => item.properties.source === 'mta') ? 'mta' : undefined);
  const mtaPublication = status?.sources.find(
    (source) => source.adapterId === 'mta-subway',
  )?.lastPublishedAt;
  const delayed =
    mode === 'mta' &&
    ((mtaPublication && now - Date.parse(mtaPublication) >= 60_000) ||
      displayEntities.some((item) => item.properties.source === 'mta' && item.stale));
  const sourceCount = status?.sources.length;
  const pick = (key: string) => {
    setSelected(key);
    setSources(false);
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="GeoAtlas home">
          <span className="brand-icon">◈</span>
          <span>
            GEOATLAS<small>FIELD OBSERVATORY</small>
          </span>
        </a>
        <nav aria-label="Main">
          <button className={!sources ? 'nav-active' : ''} onClick={() => setSources(false)}>
            Observatory
          </button>
          <button
            className={sources ? 'nav-active' : ''}
            onClick={() => setSources((value) => !value)}
          >
            Sources <span>{sourceCount?.toString().padStart(2, '0') ?? '—'}</span>
          </button>
        </nav>
        <div className="header-right">
          <span className={`demo-badge ${mode === 'mta' ? 'mixed-badge' : ''}`}>
            {mode === 'mta'
              ? 'MTA TRANSIT / DEMO VESSELS'
              : mode === 'synthetic'
                ? 'SYNTHETIC DEMO'
                : 'LOADING SOURCES'}
          </span>
          <span className={`connection ${connection}`} role="status">
            <i />
            {connection === 'live'
              ? 'Connected'
              : connection === 'connecting'
                ? 'Connecting'
                : 'Reconnecting'}
          </span>
        </div>
      </header>
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">LOCAL INTELLIGENCE / 001</div>
          <h1>
            New York, in motion<span>.</span>
          </h1>
          <p>A live canvas for transit and harbor activity.</p>
        </div>
        <div className="overview-stats">
          <div>
            <b>
              {entities
                .filter((item) => item.layer === 'subway')
                .length.toString()
                .padStart(2, '0')}
            </b>
            <span>TRAINS</span>
          </div>
          <div>
            <b>
              {entities
                .filter((item) => item.layer === 'ship')
                .length.toString()
                .padStart(2, '0')}
            </b>
            <span>VESSELS</span>
          </div>
          <div className="time-stat">
            <b>{new Date(now).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false })}</b>
            <span>UTC</span>
          </div>
        </div>
      </div>
      {connection === 'reconnecting' && (
        <div className="connection-warning" role="status">
          Connection interrupted. Showing the last received reports; their positions may be out of
          date.
        </div>
      )}
      {delayed && (
        <div className="connection-warning" role="status">
          MTA reports are more than a minute old. Information may not be real time; station markers
          show the last received associations.
        </div>
      )}
      {statusError && (
        <div className="connection-warning" role="status">
          Source health is temporarily unavailable.
        </div>
      )}
      <main className="workspace">
        <aside className="left-panel">
          <section className="layers">
            <div className="section-title">
              Map layers<span>02</span>
            </div>
            <label className="layer-option">
              <span className="layer-symbol train-symbol">↗</span>
              <span>
                <b>Subway</b>
                <small>Reported stop associations</small>
              </span>
              <input
                type="checkbox"
                checked={trains}
                onChange={(event) => setTrains(event.target.checked)}
              />
            </label>
            <div className="route-key">
              {catalog?.routes.map((item) => (
                <span key={item.id} style={{ color: item.color }}>
                  <i style={{ background: item.color }} />
                  {item.id}
                </span>
              ))}
            </div>
            <label className="layer-option">
              <span className="layer-symbol vessel-symbol">≈</span>
              <span>
                <b>Maritime</b>
                <small>Synthetic harbor reports</small>
              </span>
              <input
                type="checkbox"
                checked={ships}
                onChange={(event) => setShips(event.target.checked)}
              />
            </label>
          </section>
          <section className="entity-section">
            <div className="section-title">
              Tracked entities<span>{visible.length.toString().padStart(2, '0')}</span>
            </div>
            <label className="search">
              <span>⌕</span>
              <input
                aria-label="Search entities"
                placeholder="Find a train, vessel, or stop"
                value={search}
                maxLength={100}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="entity-list">
              {listed.map((item) => (
                <button
                  key={item.key}
                  className={`entity-row ${selected === item.key ? 'selected' : ''}`}
                  onClick={() => pick(item.key)}
                  aria-pressed={selected === item.key}
                >
                  <span
                    className={`entity-icon ${item.layer === 'ship' ? 'boat' : ''}`}
                    style={
                      item.layer === 'subway'
                        ? {
                            color: catalog?.routes.find(
                              (candidate) => candidate.id === item.properties.route,
                            )?.color,
                          }
                        : undefined
                    }
                  >
                    {item.layer === 'ship' ? '≈' : String(item.properties.route)}
                  </span>
                  <span className="entity-name">
                    <b>{label(item)}</b>
                    <small>
                      {String(item.properties.stop ?? item.properties.type ?? 'Harbor')}
                    </small>
                  </span>
                  <span className="row-age">
                    {age(item.observedAt, now)}
                    {item.stale && <small>STALE</small>}
                  </span>
                </button>
              ))}
              {!listed.length && (
                <p className="empty-state">
                  {entities.length
                    ? 'No matching entities.'
                    : mode === 'mta'
                      ? 'Waiting for MTA stop associations in this coverage…'
                      : 'Waiting for synthetic reports…'}
                </p>
              )}
            </div>
          </section>
          <div className="sidebar-note">
            <span>◌</span>
            <p>
              {mode === 'mta' ? (
                <>
                  MTA station associations.
                  <br />
                  Vessels are synthetic.
                </>
              ) : mode === 'synthetic' ? (
                <>
                  Demonstration data only.
                  <br />
                  No live trains or vessels.
                </>
              ) : (
                'Checking report sources…'
              )}
            </p>
          </div>
        </aside>
        <section className="map-panel" aria-label="Interactive geographic map">
          <div className="map-toolbar">
            <span>
              <i />
              Manhattan & harbor
            </span>
            <button
              onClick={() => setFocusToken((value) => value + 1)}
              disabled={!entity}
              title="Center map on selected entity"
            >
              ⌖ <span>Locate selected</span>
            </button>
          </div>
          {catalog ? (
            <MapView
              catalog={catalog}
              entities={visible}
              selected={selected}
              onSelect={pick}
              resetToken={resetToken}
              focusToken={focusToken}
            />
          ) : (
            <div className="loading-map" role="status">
              {loadError ? (
                <>
                  Could not load the map configuration.
                  <button onClick={() => location.reload()}>Reload</button>
                </>
              ) : (
                'Loading the observatory…'
              )}
            </div>
          )}
          <div className="map-footer">
            <span>
              <i className="legend-dot" />
              Station / report anchor
            </span>
            <span>
              <i className="legend-dot stale-dot" />
              Stale report
            </span>
            <span className="motion-note">Visual transitions · No extrapolation</span>
          </div>
        </section>
        <aside className="right-panel">
          {sources ? (
            <Sources catalog={catalog} status={status} now={now} failed={statusError} />
          ) : entity ? (
            <>
              <div className="section-title">
                Entity detail<span>↗</span>
              </div>
              <div className="detail-identity">
                <span className="eyebrow">
                  {entity.properties.source === 'mta'
                    ? 'MTA TRAIN'
                    : `SYNTHETIC ${entity.layer === 'subway' ? 'TRAIN' : 'VESSEL'}`}
                </span>
                <h2>{label(entity)}</h2>
                <span className={`detail-status ${entity.stale ? 'is-stale' : ''}`}>
                  <i />
                  {entity.stale ? 'Stale report' : 'Latest received report'}
                </span>
              </div>
              <EntityReport entity={entity} now={now} />
              {route && (
                <div className="stop-section">
                  <div className="section-title">
                    Route context<span style={{ color: route.color }}>{route.id}</span>
                  </div>
                  <ol className="stop-list">
                    {route.stops.map((stop) => (
                      <li
                        key={stop.id}
                        className={
                          stop.pathIndex === entity.properties.pathIndex ? 'current-stop' : ''
                        }
                      >
                        <i style={{ borderColor: route.color }} />
                        <span>
                          {stop.name}
                          {stop.pathIndex === entity.properties.pathIndex && (
                            <small>REPORT ANCHOR</small>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="detail-note">{reportPresentation(entity).note}</div>
            </>
          ) : (
            <div className="empty-state">Select an entity to inspect its latest report.</div>
          )}
        </aside>
      </main>
      <footer className="page-footer">
        <span>
          GEOATLAS <i>/</i> OPEN GEOSPATIAL OBSERVATORY
        </span>
        <span>
          {mode === 'mta'
            ? 'MTA transit · Synthetic vessels'
            : mode === 'synthetic'
              ? 'Synthetic reports · MTA route geometry'
              : 'MTA route geometry'}
        </span>
      </footer>
    </div>
  );
}

function EntityReport({ entity, now }: { entity: TrackedEntity; now: number }) {
  const presentation = reportPresentation(entity);
  return (
    <>
      <div className="detail-location">
        <span className="eyebrow">{presentation.heading}</span>
        <h3>{String(entity.properties.stop ?? 'New York Harbor')}</h3>
        <p>{presentation.description}</p>
      </div>
      <dl className="detail-data">
        <div>
          <dt>{presentation.clock}</dt>
          <dd>{age(entity.observedAt, now)}</dd>
        </div>
        <div>
          <dt>Report time</dt>
          <dd>
            {new Date(entity.observedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC
          </dd>
        </div>
        {typeof entity.properties.lastMovementAt === 'string' && (
          <div>
            <dt>Last detected movement</dt>
            <dd>{age(entity.properties.lastMovementAt, now)}</dd>
          </div>
        )}
        <div>
          <dt>{entity.properties.source === 'mta' ? 'Station latitude' : 'Latitude'}</dt>
          <dd>{entity.latitude.toFixed(5)}°</dd>
        </div>
        <div>
          <dt>{entity.properties.source === 'mta' ? 'Station longitude' : 'Longitude'}</dt>
          <dd>{entity.longitude.toFixed(5)}°</dd>
        </div>
      </dl>
    </>
  );
}

function Sources({
  catalog,
  status,
  now,
  failed,
}: {
  catalog: Catalog | null;
  status: DashboardStatus | null;
  now: number;
  failed: boolean;
}) {
  const live = status?.mode === 'mta';
  return (
    <>
      <div className="section-title">
        Source health<span>{status?.sources.length.toString().padStart(2, '0') ?? '—'}</span>
      </div>
      <div className="source-intro">
        <h2>Behind the map.</h2>
        <p>
          {live
            ? 'MTA A/C/E station associations are fetched server-side. Harbor reports are synthetic.'
            : status
              ? 'All four report inputs run locally. The geographic background is loaded from OpenFreeMap.'
              : 'Checking report sources…'}
        </p>
      </div>
      {status?.sources.map((source) => (
        <div className="source-card" key={`${source.adapterId}-${source.inputId}`}>
          <b>
            {source.inputId === 'harbor'
              ? 'Synthetic harbor'
              : source.inputId === 'ace'
                ? 'MTA A/C/E feed'
                : `${source.inputId.toUpperCase()} line demo`}
          </b>
          <span className={source.status === 'healthy' ? 'source-ok' : 'source-warn'}>
            {source.status}
          </span>
          <small>
            {source.lastSuccessAt
              ? `Last received ${age(source.lastSuccessAt, now)}`
              : 'Awaiting first report'}
          </small>
          {source.lastPublishedAt && (
            <small>Feed published {age(source.lastPublishedAt, now)}</small>
          )}
        </div>
      ))}
      {failed && <p role="alert">Source health is temporarily unavailable.</p>}
      <div className="geometry-source">
        <span className="eyebrow">GEOGRAPHY SOURCES</span>
        <h3>Geographic context.</h3>
        <p>
          Street and shoreline background:{' '}
          <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">
            OpenFreeMap / OpenStreetMap
          </a>
          .
        </p>
        <p>
          Routes and station positions:{' '}
          <a href="https://www.mta.info/developers" target="_blank" rel="noreferrer">
            MTA static GTFS
          </a>
          , served from GeoAtlas.
        </p>
        {catalog?.source && (
          <>
            <small>
              Retrieved {catalog.source.retrievedAt}
              <br />
              Feed version: {catalog.source.feedVersion}
            </small>
            <p>
              Representative static shapes only. Unknown patterns fade between station anchors;
              current routing is not guaranteed.
            </p>
            <a href={catalog.source.termsUrl} target="_blank" rel="noreferrer">
              MTA data terms ↗
            </a>
          </>
        )}
      </div>
      <div className="detail-note">
        {live
          ? 'A/C/E polls every 30 seconds. Only station associations within the Manhattan catalog are shown. Trip predictions are not mapped as train positions.'
          : 'Transit updates every 6 seconds. The harbor emits one synthetic vessel report every 2 seconds.'}{' '}
        MTA data is provided as is; GeoAtlas is not MTA-endorsed.
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
