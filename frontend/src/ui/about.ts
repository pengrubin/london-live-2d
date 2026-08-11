// About / data-credits view for the control panel: what this map is, where
// every layer's data comes from, and the licences that data arrives under.
//
// Sources are derived from the capabilities layer set (hasLayer) — the same
// signal that decides whether a layer exists — so a deployment only credits
// the feeds it actually draws: Dubai never claims TfL, London never hides it.
// The map-corner attribution line stays short; this view carries the full
// licence wording (TfL's required text, OGL, ODbL) and the acknowledgements.

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
      when: usesTfl,
      html:
        `${link('https://tfl.gov.uk/info-for/open-data-users/', 'Powered by TfL Open Data')}. ` +
        'Contains OS data © Crown copyright and database rights 2016 ' +
        'and Geomni UK Map data © and database rights 2019.',
    },
    {
      when: hasLayer('buses'),
      html:
        `Bus positions: ${link('https://www.bus-data.dft.gov.uk/', 'DfT Bus Open Data Service')} ` +
        `(${link('https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/', 'OGL v3')}).`,
    },
    {
      when: hasLayer('nationalRail'),
      html: 'National Rail departures: Darwin, © Rail Delivery Group.',
    },
    {
      when: true,
      html:
        `Network geometry &amp; basemap: © ${link('https://www.openstreetmap.org/copyright', 'OpenStreetMap')} contributors ` +
        `(${link('https://opendatacommons.org/licenses/odbl/', 'ODbL')}), ` +
        `tiles by ${link('https://protomaps.com', 'Protomaps')}.`,
    },
    {
      when: hasLayer('tideGauges'),
      html: `Tide gauges: ${link('https://environment.data.gov.uk/', 'Environment Agency')} (OGL v3).`,
    },
    {
      when: hasLayer('vessels'),
      html: `Ship positions: ${link('https://aisstream.io', 'aisstream.io')}.`,
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
    'A real-time 2D transport map, estimated in your browser from open data. ' +
    `Source on ${link(REPO_URL, 'GitHub')} — code MIT, baked network geometry ODbL.`;

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

  // The countdown→position primitive behind the train layer is Zone One's idea;
  // this project's contribution is the per-mode hardening on top of it.
  if (hasLayer('trainPositions')) {
    const ackHeader = document.createElement('div');
    ackHeader.className = 'legend-group';
    ackHeader.textContent = 'Acknowledgements';
    const ack = document.createElement('div');
    ack.className = 'about-note';
    ack.innerHTML =
      'Train positions are inferred from arrival countdowns — an approach ' +
      `pioneered by ${link('https://london.jamespotter.dev', 'Zone One')}.`;
    container.append(ackHeader, ack);
  }
}
