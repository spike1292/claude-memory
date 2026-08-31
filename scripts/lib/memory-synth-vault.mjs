#!/usr/bin/env node
// Generate a FIXED synthetic vault + query sets, so retrieval numbers are reproducible.
//
// Deterministic: seeded PRNG, no Date.now(), no Math.random(). Same seed -> byte-identical vault.
// Prose is ordinary English/Dutch so meaning is real; only product NAMES are invented, so gold
// stays unique and never collides with a real note.
//
// The seed-7 baseline table, the rejected hardening attempt, and why the English case set is at
// its ceiling (must not be quoted as evidence — use the real-vault case sets for small deltas):
// docs/decisions/2026-08-15-synth-vault-baseline.md.
//
// Logic half; the CLI entry is scripts/memory-synth-vault.mjs.
// Tests: node --test scripts/lib/memory-synth-vault.test.mjs
//
// Usage:
//   node scripts/memory-synth-vault.mjs --out /tmp/synthvault [--notes 300] [--seed 7] [--echoes 2]
//   node memory-semantic.mjs --vault /tmp/synthvault --slug bench --index --rebuild
//   node memory-eval.mjs --vault /tmp/synthvault --slug bench --run --cases /tmp/synthvault/cases-paraphrase.jsonl

// ---------------------------------------------------------------- seeded PRNG
/**
 * @param {number} a
 * @returns {() => number}
 */
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the material
// Each entry is one GOLD note. `title` words are deliberately absent from `ask` (the paraphrase),
// which is the whole point: a question that shares title tokens tests keyword matching, not meaning.
// `key` is the keyword-style question that SHOULD be easy. `nl` is the Dutch paraphrase.
export const DOMAINS = [
  {
    name: 'caching',
    product: 'Vantrel',
    cases: [
      {
        title: 'stale-html-survives-a-release',
        body: 'The edge keeps handing back the previous build long after the rollout finishes, because the invalidation runs before the origin has the new files. Order the two and the window closes.',
        ask: 'old pages keep being served to users after we ship a new version',
        key: 'Vantrel stale html release invalidation',
        nl: 'oude paginas worden nog steeds getoond nadat we een nieuwe versie hebben uitgerold',
      },
      {
        title: 'query-parameters-fragment-the-cache-key',
        body: 'Every tracking parameter that reaches the key creates a separate stored copy, so the hit rate collapses while the object count explodes. An allowlist of the parameters that actually change the response fixes it.',
        ask: 'our hit rate is terrible and we store thousands of near identical copies',
        key: 'Vantrel cache key query parameter allowlist',
        nl: 'onze hit ratio is slecht en we bewaren duizenden bijna identieke kopieen',
      },
      {
        title: 'immutable-assets-share-a-policy-with-mutable-media',
        body: 'Hashed files can be kept for a year, uploaded images cannot. One shared lifetime forces the safe short value onto both, so the fingerprinted files are re-fetched for no reason.',
        ask: 'files with a content hash in the name are downloaded again far too often',
        key: 'Vantrel immutable asset media cache policy split',
        nl: 'bestanden met een hash in de naam worden veel te vaak opnieuw opgehaald',
      },
      {
        title: 'origin-owns-the-lifetime-header',
        body: 'The delivery layer only repeats what the backend declares. Tuning the distribution while the backend still sends a one-minute lifetime changes nothing at all.',
        ask: 'i changed the setting on the distribution and nothing happened',
        key: 'Vantrel origin cache control header respected',
        nl: 'ik heb de instelling op de distributie aangepast en er gebeurde niets',
      },
      {
        title: 'purge-is-eventually-consistent-across-regions',
        body: 'A clear request returns success immediately but each location drops its copy on its own schedule, so two people in different countries disagree about what is live for several minutes.',
        ask: 'two colleagues in different countries see different content at the same moment',
        key: 'Vantrel purge eventual consistency regions',
        nl: 'twee collegas in verschillende landen zien op hetzelfde moment andere inhoud',
      },
    ],
  },
  {
    name: 'authentication',
    product: 'Kelbrin',
    cases: [
      {
        title: 'refresh-storm-after-a-clock-skew',
        body: 'When the server drifts ahead, every client believes its credential expired and asks for a new one at the same instant. The renewal endpoint then falls over from self-inflicted load.',
        ask: 'all our users were signed out at once and the renewal service collapsed',
        key: 'Kelbrin refresh storm clock skew',
        nl: 'al onze gebruikers werden tegelijk uitgelogd en de vernieuwdienst viel om',
      },
      {
        title: 'the-identity-cookie-cannot-be-read-by-the-browser',
        body: 'It is marked so that only the server sees it, which is correct, and it also means the page script that tries to attach the account to an error report always finds nothing.',
        ask: 'our crash reports never show which account hit the problem',
        key: 'Kelbrin httponly cookie account attribution',
        nl: 'onze foutmeldingen laten nooit zien welk account het probleem had',
      },
      {
        title: 'open-redirect-hides-in-the-return-address',
        body: 'The parameter that says where to go after signing in is taken at face value, so an attacker can send someone to their own page carrying a valid session.',
        ask: 'can someone forward a signed in visitor to a site they control',
        key: 'Kelbrin open redirect return url validation',
        nl: 'kan iemand een ingelogde bezoeker doorsturen naar een eigen website',
      },
      {
        title: 'scope-gap-returns-a-permission-error-not-a-login-prompt',
        body: 'The gateway accepts the credential, then the backend refuses one capability it never granted. It reads as a broken sign-in, but nothing about the sign-in is wrong.',
        ask: 'the api says forbidden even though the person is definitely signed in',
        key: 'Kelbrin scope capability gap 401',
        nl: 'de api zegt verboden terwijl de persoon zeker is ingelogd',
      },
      {
        title: 'server-side-rendering-has-no-browser-to-hold-the-session',
        body: 'The first render happens where no cookie jar exists, so anything that assumes a signed-in reader produces the anonymous variant and then flickers when the page wakes up.',
        ask: 'the page briefly shows the logged out version before correcting itself',
        key: 'Kelbrin ssr session cookie first render',
        nl: 'de pagina toont kort de uitgelogde versie voordat hij zichzelf corrigeert',
      },
    ],
  },
  {
    name: 'monitoring',
    product: 'Orsalind',
    cases: [
      {
        title: 'thresholds-calibrated-on-a-quiet-period',
        body: 'The numbers were chosen while almost no real visitors were present, so they describe an empty system. After the switchover the same limits fire constantly or never fire at all.',
        ask: 'is it safe to set alert limits from what the graphs show right now',
        key: 'Orsalind alarm threshold calibration baseline',
        nl: 'kan ik alarmgrenzen baseren op wat de grafieken nu laten zien',
      },
      {
        title: 'the-widget-is-keyed-by-full-resource-address',
        body: 'Supplying the short name produces an empty panel rather than an error, so the board looks healthy while measuring nothing.',
        ask: 'my dashboard panel is blank but it does not report any failure',
        key: 'Orsalind widget dimension full arn empty tile',
        nl: 'mijn dashboardpaneel is leeg maar geeft geen enkele fout',
      },
      {
        title: 'log-search-truncates-a-large-response',
        body: 'The query stops at a size limit and returns what fits. Absence of a record therefore proves nothing unless every page was walked.',
        ask: 'i searched the logs and found nothing, can i conclude it never happened',
        key: 'Orsalind filter log events 1mb truncation paginate',
        nl: 'ik heb de logs doorzocht en niets gevonden, mag ik concluderen dat het nooit gebeurde',
      },
      {
        title: 'panel-heights-differ-by-type-and-later-rows-float-up',
        body: 'A single-value tile is shorter than a chart, and the layout engine pulls the following row into the leftover space, so a board built in a tidy grid renders as a staircase.',
        ask: 'my dashboard layout looks scrambled after i added one small tile',
        key: 'Orsalind widget height single value graph layout',
        nl: 'mijn dashboardindeling ziet er rommelig uit nadat ik een kleine tegel toevoegde',
      },
      {
        title: 'detailed-collection-is-billed-per-series-and-per-task',
        body: 'The richer level multiplies with how many instances run, so a fleet that scales out at peak also scales the invoice, and list prices overstate it when volume discounts already apply.',
        ask: 'how much does the richer observability tier actually cost us per month',
        key: 'Orsalind container insights enhanced pricing tier',
        nl: 'hoeveel kost de uitgebreide observatielaag ons daadwerkelijk per maand',
      },
    ],
  },
  {
    name: 'delivery-pipeline',
    product: 'Trestamo',
    cases: [
      {
        title: 'a-green-badge-hides-cancelled-child-work',
        body: 'The parent reports success while jobs inside a nested run were quietly dropped, so a deploy that never happened looks finished.',
        ask: 'the build says it passed but the release never reached production',
        key: 'Trestamo pipeline green badge cancelled child jobs',
        nl: 'de build zegt geslaagd maar de release bereikte productie nooit',
      },
      {
        title: 'squash-merging-destroys-the-shared-ancestor',
        body: 'Collapsing a branch into one commit removes the point both sides agreed on, so a later attempt to undo the change has nothing to subtract from.',
        ask: 'why can i not revert that change cleanly any more',
        key: 'Trestamo squash merge base revert broken',
        nl: 'waarom kan ik die wijziging niet meer netjes terugdraaien',
      },
      {
        title: 'in-flight-work-outruns-a-stale-queued-job',
        body: 'A newer run overtakes an older queued one, and the older one lands last, putting the previous artifact back on top of the newer one.',
        ask: 'an older version replaced the newer one after both finished',
        key: 'Trestamo pipeline auto cancel resource group ordering',
        nl: 'een oudere versie verving de nieuwere nadat beide klaar waren',
      },
      {
        title: 'nested-runs-are-invisible-to-the-listing-endpoint',
        body: 'Asking for the runs of a project omits anything triggered as a child, so an inventory built from that list silently misses whole stages.',
        ask: 'my script counted the builds but missed several stages entirely',
        key: 'Trestamo child pipeline bridges endpoint listing',
        nl: 'mijn script telde de runs maar miste verschillende fases volledig',
      },
      {
        title: 'disabling-a-noisy-check-hides-a-real-one',
        body: 'The step was already failing before this change and was switched off to get a clean run, which also switched off the signal that would have caught the new fault.',
        ask: 'should i switch off something that was failing before my work started',
        key: 'Trestamo pre-existing non blocking failure disable',
        nl: 'moet ik een controle uitzetten die al kapot was voor mijn wijziging',
      },
    ],
  },
  {
    name: 'edge-security',
    product: 'Belmoyra',
    cases: [
      {
        title: 'the-filter-rule-lives-in-another-teams-account',
        body: 'The block happens before any of our own configuration is consulted, and the change has to be requested from the group that owns it rather than raised as a change to our own repository.',
        ask: 'who do i ask to open a blocked path, we cannot change it ourselves',
        key: 'Belmoyra web acl rule ownership other team',
        nl: 'aan wie vraag ik om een geblokkeerd pad te openen, we kunnen het zelf niet wijzigen',
      },
      {
        title: 'automated-crawlers-cause-the-refusal-spikes',
        body: 'The rejections arrive in waves on a weekly rhythm and almost all carry one automated agent string. They track the crawler, not anything we released.',
        ask: 'we get bursts of rejected requests every week with no deploy nearby',
        key: 'Belmoyra bot rule 403 spike weekly cycle',
        nl: 'we krijgen elke week golven van geweigerde verzoeken zonder release in de buurt',
      },
      {
        title: 'the-corporate-proxy-mimics-a-permission-failure',
        body: 'A network appliance answers instead of the service and returns a refusal that carries headers implying a real account check, so it looks like a rights problem rather than interception.',
        ask: 'the tool says forbidden, is my access dead or is something in between',
        key: 'Belmoyra proxy intercept 403 false permission failure',
        nl: 'de tool zegt verboden, is mijn toegang verlopen of zit er iets tussen',
      },
      {
        title: 'a-probe-that-expects-success-reports-its-own-runtime',
        body: 'The healthy answer is a redirect, but the check only accepts a plain success, so it records a failure for the whole time it runs and the duration looks like an outage.',
        ask: 'my availability check reported an outage exactly as long as the check itself',
        key: 'Belmoyra probe expects 200 healthy is 302',
        nl: 'mijn beschikbaarheidscontrole meldde een storing precies zo lang als de controle zelf duurde',
      },
      {
        title: 'non-production-stays-closed-to-the-public-internet',
        body: 'Only the live environment was opened. The others still answer nothing outside the office network, which is intended and is not a fault to be reported.',
        ask: 'the test environment does not answer from my home connection',
        key: 'Belmoyra non production egress restricted corporate',
        nl: 'de testomgeving reageert niet vanaf mijn thuisverbinding',
      },
    ],
  },
  {
    name: 'memory-and-runtime',
    product: 'Quorvex',
    cases: [
      {
        title: 'the-interpreter-heap-cap-sits-above-the-container-limit',
        body: 'The process is allowed to grow past what the box will give it, so instead of collecting garbage it is killed outright and the crash looks like an unrelated restart.',
        ask: 'our service is being terminated instead of cleaning up its own memory',
        key: 'Quorvex heap cap container memory oom kill',
        nl: 'onze dienst wordt afgebroken in plaats van zijn eigen geheugen op te ruimen',
      },
      {
        title: 'a-build-argument-does-not-survive-into-the-running-image',
        body: 'The value is available while assembling the image and then disappears, so the running process falls back to a default nobody chose.',
        ask: 'the value i supplied while packaging is gone once the process starts',
        key: 'Quorvex build arg env runtime not persisted',
        nl: 'de instelling die ik meegaf tijdens de build ontbreekt als de container draait',
      },
      {
        title: 'a-cold-cache-plus-a-crawler-wave-exhausts-the-workers',
        body: 'Every request has to be produced from scratch at the moment a bulk reader arrives, and the two together push the renderers past their ceiling.',
        ask: 'we had a burst of errors when an automated reader arrived on an empty store',
        key: 'Quorvex cold cache crawler storm ssr workers',
        nl: 'we hadden een golf van fouten toen een bulklezer arriveerde bij een lege cache',
      },
      {
        title: 'addresses-run-out-before-capacity-does',
        body: 'The subnet cannot number any more instances even though there is plenty of compute left, and no built-in measurement reports the remaining headroom.',
        ask: 'scaling stopped even though the cluster still had plenty of room',
        key: 'Quorvex subnet ip exhaustion no native metric',
        nl: 'het opschalen stopte terwijl er nog capaciteit over was in het cluster',
      },
      {
        title: 'the-rolling-controller-makes-one-count-meaningless',
        body: 'With the simple release strategy the grouping counter never moves, so a panel built on it shows a flat line that means nothing rather than a healthy system.',
        ask: 'this counter never changes, is the system healthy or is the panel wrong',
        key: 'Quorvex rolling deployment controller task set count',
        nl: 'deze teller verandert nooit, is het systeem gezond of klopt het paneel niet',
      },
    ],
  },
  {
    name: 'workspace-tooling',
    product: 'Haldreth',
    cases: [
      {
        title: 'boundary-tags-only-govern-projects-that-carry-them',
        body: 'A package with no label is exempt from the import rules, so a forbidden dependency passes review because the checker was never asked about it.',
        ask: 'a banned import slipped through, why did the rule not catch it',
        key: 'Haldreth module boundary tag untagged project',
        nl: 'een verboden import glipte erdoor, waarom greep de regel niet in',
      },
      {
        title: 'parallel-test-workers-exhaust-the-machine',
        body: 'Each worker loads its own copy and the total outgrows the host, so the suite dies from resource pressure rather than from a real assertion.',
        ask: 'the suite dies without any assertion actually going red',
        key: 'Haldreth jest parallel workers memory run in band',
        nl: 'de testrun sterft zonder dat er echt een test faalt',
      },
      {
        title: 'a-barrel-file-drags-in-the-whole-area',
        body: 'Importing one symbol through the shared entry point pulls every sibling with it, which inflates the bundle and hides which parts are really used.',
        ask: 'our bundle grew enormously after importing a single helper',
        key: 'Haldreth barrel index export bundle size',
        nl: 'onze bundel groeide enorm nadat we een enkele helper importeerden',
      },
      {
        title: 'the-type-checker-is-skipped-by-the-fast-transform',
        body: 'The compiler option that speeds compilation also means specification files are transformed without ever being checked, so a broken type ships green.',
        ask: 'my test compiled fine but the types in it were wrong all along',
        key: 'Haldreth isolated modules ts-jest no typecheck',
        nl: 'mijn test compileerde prima maar de types erin waren al die tijd fout',
      },
      {
        title: 'the-formatter-rewrites-machine-edited-tables',
        body: 'A script that edits a generated table has its output reflowed on commit, so the next run no longer recognises what it wrote.',
        ask: 'my generator stopped matching its own output after committing',
        key: 'Haldreth prettier reformat generated table script',
        nl: 'mijn generator herkende zijn eigen uitvoer niet meer na het committen',
      },
    ],
  },
  {
    name: 'issue-tracking',
    product: 'Nirvale',
    cases: [
      {
        title: 'the-duplicate-was-already-open-for-months',
        body: 'A new item was raised for work that had been recorded long before, including in closed and rejected states, so effort was split across two records nobody reconciled.',
        ask: 'i raised a work item that turned out to exist somewhere else',
        key: 'Nirvale duplicate ticket search backlog first',
        nl: 'ik heb een werkitem aangemaakt dat al bleek te bestaan',
      },
      {
        title: 'creation-hangs-when-a-parent-is-supplied-inline',
        body: 'Passing the containing record while creating the item never returns. Creating it bare and attaching the parent afterwards works every time.',
        ask: 'the command never finishes when i also give it the containing record',
        key: 'Nirvale create hangs parent epic flag',
        nl: 'de opdracht eindigt nooit als ik ook het bovenliggende record meegeef',
      },
      {
        title: 'an-empty-description-is-still-a-claim-on-the-work',
        body: 'A stub record with no text still represents a decision that the work belongs to someone. Repurpose it rather than opening a rival next to it.',
        ask: 'there is a blank entry already, should i make a proper new one instead',
        key: 'Nirvale empty description stub repurpose not rival',
        nl: 'er bestaat een lege invoer, moet ik een nette nieuwe maken',
      },
      {
        title: 'two-workflows-share-one-board',
        body: 'One record type can move between any states while another is gated stage by stage, so a transition that works for one is refused for the other on the same board.',
        ask: 'the same status change is accepted for one item and refused for another',
        key: 'Nirvale board two workflows story feature gated',
        nl: 'dezelfde statuswijziging wordt bij het ene item geaccepteerd en bij het andere geweigerd',
      },
      {
        title: 'an-inline-comment-lands-without-its-position',
        body: 'The call returns a success code and creates a note with no anchor, so the remark appears detached from the line it was about.',
        ask: 'my review remark attached itself to the wrong place in the change',
        key: 'Nirvale inline comment position dropped 201',
        nl: 'mijn revisieopmerking kwam op de verkeerde plek in de wijziging terecht',
      },
    ],
  },
];

// ECHO notes: the hardening lever — one gold-diverging distractor per case. Why the first version
// had no headroom, and what was tried: docs/decisions/2026-08-15-synth-vault-baseline.md.
//
// Danger: an echo that is TOO close stops being a distractor and becomes a second valid answer,
// making gold ambiguous. Verify with the keyword case set: it must still find gold first. Keyword
// recall holding while paraphrase recall drops means the echo added difficulty without destroying
// gold identity; keyword recall dropping too means the echo is ambiguous and must be weakened.
export const ECHO_CAUSES = [
  [
    'a stale configuration default nobody revisited',
    'change the default and redeploy the component that reads it',
  ],
  [
    'a retry policy that hides the first failure',
    'surface the first failure instead of swallowing it',
  ],
  [
    'a permission that was granted at the wrong level',
    'move the grant to the level that actually evaluates it',
  ],
];

// Filler notes are never gold. They exist to be plausible competition — the real failure mode
// measured on 2026-08-15 was the right note losing to a SIMILAR SIBLING, not to a random note.
export const FILLER_ASPECTS = [
  [
    'rollout-checklist',
    'A step by step list used before a change goes out, covering who approves it and what gets checked afterwards.',
  ],
  [
    'naming-conventions',
    'How things in this area are named, which prefixes are reserved, and what a reviewer should reject.',
  ],
  [
    'ownership-and-escalation',
    'Who is accountable for this area, who to page outside office hours, and what counts as urgent.',
  ],
  [
    'known-limitations',
    'Behaviour that looks like a defect but is accepted, with the reason it has not been changed.',
  ],
  [
    'glossary-of-terms',
    'Short definitions for the words used across this area so that new readers are not guessing.',
  ],
  [
    'review-guidance',
    'What a reviewer should look at first in this area and which mistakes recur most often.',
  ],
  [
    'historic-decisions',
    'Choices made earlier in this area, the alternatives considered, and why they were set aside.',
  ],
  [
    'test-strategy',
    'Which behaviour is covered automatically here, what is checked by hand, and where the gaps are.',
  ],
];

// ---------------------------------------------------------------- generation

/**
 * @param {string} name
 * @param {string} description
 * @param {string} body
 * @param {string[]} aliases
 * @param {string[]} links
 * @returns {string}
 */
export function noteText(name, description, body, aliases, links) {
  return `---
name: ${name}
description: "${description}"
synthetic: true
metadata:
  type: reference
  confidence: high
---

# ${description}

${body}

## Detail

${body} This section repeats the substance so the note has more than one retrievable region, the
way a real note does. ${links.map((l) => `See [[${l}]].`).join(' ')}

_Also asked as: ${aliases.join(', ')}._
`;
}
