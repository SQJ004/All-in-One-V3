import { automationModule } from '../modules/automation/index.js';
import { engagementModule } from '../modules/community/engagement.js';
import { levelsModule } from '../modules/community/levels.js';
import { membersModule } from '../modules/community/members.js';
import { embedsModule } from '../modules/embeds/index.js';
import { generalModule } from '../modules/general/index.js';
import { loggingModule } from '../modules/logging/index.js';
import { moderationModule } from '../modules/moderation/index.js';
import { musicModule } from '../modules/music/index.js';
import { backupModule } from '../modules/backup/index.js';
import { platformModule } from '../modules/platform/index.js';
import { staffModule } from '../modules/staff/index.js';
import { rolesModule } from '../modules/roles/index.js';
import { securityModule } from '../modules/security/index.js';
import { ticketsModule } from '../modules/tickets/index.js';
import { utilityModule } from '../modules/utility/index.js';
import { welcomeModule } from '../modules/welcome/index.js';
import type { VortexModule } from './types.js';

/** Security runs first so a banned raider never reaches welcome messages or auto roles. */
export const MODULES: VortexModule[] = [
  securityModule, loggingModule, moderationModule, welcomeModule, embedsModule, rolesModule, ticketsModule, automationModule, levelsModule, engagementModule, membersModule, generalModule, musicModule, utilityModule, backupModule, platformModule, staffModule,
];

export const allCommandData = () => MODULES.flatMap((m) => m.commands ?? []).map((c) => c.data);
