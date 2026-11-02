import type { TrackedEntity } from '@geoatlas/adapter-core';

export function reportPresentation(entity: Pick<TrackedEntity, 'layer' | 'properties'>): {
  heading: string;
  description: string;
  clock: string;
  note: string;
} {
  if (entity.layer !== 'subway')
    return {
      heading: 'LAST REPORTED POSITION',
      description: `${entity.properties.type ?? 'Vessel'} · Synthetic position`,
      clock: 'Observation',
      note: 'Synthetic harbor report. Display movement is not a live vessel position.',
    };
  const association = entity.properties.association;
  const heading =
    association === 'at'
      ? 'REPORTED AT STOP'
      : association === 'approaching'
        ? 'APPROACHING REPORTED STOP'
        : association === 'in_transit_to'
          ? 'IN TRANSIT TO REPORTED STOP'
          : 'REPORTED STOP ASSOCIATION';
  const description =
    association === 'at'
      ? 'Reported at stop'
      : association === 'approaching'
        ? 'Reported approaching stop'
        : association === 'in_transit_to'
          ? 'Reported in transit to stop'
          : 'Stop status not provided';
  const mta = entity.properties.source === 'mta';
  return {
    heading,
    description: `${entity.properties.direction ?? ''} · ${description}`,
    clock: mta ? 'Feed publication' : 'Observation',
    note: mta
      ? `Marker anchored to the associated station, not an exact train position. ${entity.properties.animation === 'fade' ? 'Path unverified; marker fades between reports.' : 'Track transitions are visual only.'}`
      : 'Markers transition smoothly to new synthetic reports, then hold. Movement between reports is not predicted.',
  };
}
