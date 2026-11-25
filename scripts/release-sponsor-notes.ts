// Prints the sponsor line the release workflow prepends to generated notes.
// The registry is the site's (site/src/lib/sponsors.ts), so the README, the
// site and every release credit the same sponsors through the same hop.
import { sponsorReleaseLine } from '../site/src/lib/sponsors';

process.stdout.write(sponsorReleaseLine('https://wigolo.app'));
