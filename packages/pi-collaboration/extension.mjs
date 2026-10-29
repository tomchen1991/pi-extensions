import { registerCollaboration } from './extension-factory.mjs';

export default function piCollaboration(pi) {
  return registerCollaboration(pi, {
    launchKey: 'standalone.pi-collaboration.launch.v1',
    envPrefix: 'PI_COLLAB',
    toolName: 'pi_collaboration',
    customType: 'pi-peer-message',
    statusKey: 'pi-collaboration',
    label: 'PI 协作',
    optional: true,
    missingCredentials: '请使用 pi-collab join 启动协作 PI',
  });
}
