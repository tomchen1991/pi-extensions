// Explicit DeckZ entry only; do not add this to the ordinary Pi package manifest.
import { registerCollaboration } from './extension-factory.mjs';

export default function deckzCollaboration(pi) {
  return registerCollaboration(pi, {
    launchKey: 'deckz.pi-collaboration.launch.v1',
    envPrefix: 'DECKZ_PI_COLLAB',
    toolName: 'deckz_collaboration',
    customType: 'deckz-peer-message',
    statusKey: 'deckz-collaboration',
    label: 'DeckZ 协作',
    optional: false,
    missingCredentials: '请从 DeckZ 的“启动协作 PI”入口加载此扩展',
  });
}
