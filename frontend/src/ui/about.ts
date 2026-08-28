// About / data-credits view for the control panel: what this map is and where
// every layer's data comes from, one terse line per source.
//
// Sources are derived from the capabilities layer set (hasLayer) — the same
// signal that decides whether a layer exists — so a deployment only credits
// the feeds it actually draws: Dubai never claims TfL, London never hides it.
// Panel space is premium: only the legally required notices stay here (TfL's
// prescribed wording, OSM/ODbL); everything long-form — full licence text,
// acknowledgements (Zone One) — lives in the README.

import { hasLayer } from '../region';

const REPO_URL = 'https://github.com/pengrubin/london-live-2d';

interface CreditEntry {
  /** Show only when the deployment actually draws this data. */
  readonly when: boolean;
  readonly html: string;
}

function link(href: string, text: string): string {
  return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
}

function buildCredits(): CreditEntry[] {
  const usesTfl =
    hasLayer('trainPositions') ||
    hasLayer('stopArrivals') ||
    hasLayer('lineStatus') ||
    hasLayer('jamCams') ||
    hasLayer('roadDisruptions') ||
    hasLayer('bikePoints');
  return [
    {
      // TfL's licence prescribes this attribution and the OS/Geomni notice —
      // the one entry that cannot be shortened further.
      when: usesTfl,
      html:
        `${link('https://tfl.gov.uk/info-for/open-data-users/', 'Powered by TfL Open Data')}. ` +
        'Contains OS data © Crown copyright and database rights 2016 ' +
        'and Geomni UK Map data © and database rights 2019.',
    },
    {
      // busCoverage is BODS-derived too (learned from SIRI-VM traces): the
      // credit must survive losing the live key while coverage still renders.
      when: hasLayer('buses') || hasLayer('busCoverage'),
      html: `Buses: ${link('https://www.bus-data.dft.gov.uk/', 'DfT BODS')} (OGL v3).`,
    },
    {
      when: hasLayer('nationalRail'),
      html: 'National Rail: Darwin © Rail Delivery Group.',
    },
    {
      when: true,
      html:
        `Map &amp; routes: © ${link('https://www.openstreetmap.org/copyright', 'OpenStreetMap')} ` +
        `(${link('https://opendatacommons.org/licenses/odbl/', 'ODbL')}), ` +
        `${link('https://protomaps.com', 'Protomaps')} tiles.`,
    },
    {
      when: hasLayer('tideGauges'),
      html: `Tides: ${link('https://environment.data.gov.uk/', 'Environment Agency')} (OGL v3).`,
    },
    {
      when: hasLayer('vessels'),
      html: `Ships: ${link('https://aisstream.io', 'aisstream.io')}.`,
    },
    {
      when: hasLayer('aircraft'),
      html:
        `Aircraft: ${link('https://airplanes.live', 'airplanes.live')} / ` +
        `${link('https://adsb.lol', 'adsb.lol')}.`,
    },
    {
      when: hasLayer('rainRadar'),
      html: `Rain radar: ${link('https://www.rainviewer.com/', 'RainViewer')}.`,
    },
    {
      when: hasLayer('bikeStations'),
      html: 'Bike share: operator GBFS feed.',
    },
  ];
}

/** Build the About view into `container` (a control-panel section). */
export function addAbout(container: HTMLElement): void {
  const intro = document.createElement('div');
  intro.className = 'about-note';
  intro.innerHTML =
    'Real-time transport map from open data. ' +
    `${link(REPO_URL, 'Source on GitHub')} — full licences &amp; credits there.`;

  const sourcesHeader = document.createElement('div');
  sourcesHeader.className = 'legend-group';
  sourcesHeader.textContent = 'Data sources';

  const sources = document.createElement('div');
  sources.className = 'about-note';
  sources.innerHTML = buildCredits()
    .filter((entry) => entry.when)
    .map((entry) => `<div class="about-credit">${entry.html}</div>`)
    .join('');

  container.append(intro, sourcesHeader, sources);
}
