import { z } from 'zod';

// Every IPC payload coming from the renderer is parsed with one of these before use.

export const IdSchema = z.uuid();
export const IdListSchema = z.array(IdSchema).min(1).max(64);

const ipOrCidr = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

export const RouteRuleSchema = z
  .object({
    id: IdSchema,
    type: z.enum(['cidr', 'ip', 'hostname']),
    value: z.string().trim().min(1).max(253),
  })
  .superRefine((rule, ctx) => {
    const ok =
      rule.type === 'hostname' ? z.hostname().safeParse(rule.value).success : ipOrCidr.safeParse(rule.value).success;
    if (!ok) ctx.addIssue({ code: 'custom', message: `Invalid ${rule.type}: ${rule.value}`, path: ['value'] });
  });

export const ProfilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    username: z.string().max(256),
    autoConnect: z.boolean(),
    reconnect: z.boolean(),
    routingMode: z.enum(['config', 'custom']),
    customRoutes: z.array(RouteRuleSchema).max(500),
    dnsMode: z.enum(['vpn', 'system', 'custom']),
    dnsServers: z.array(z.union([z.ipv4(), z.ipv6()])).max(8),
    ignoreRedirectGateway: z.boolean(),
  })
  .partial()
  .strict();
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

export const SettingsPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    openvpnPath: z.string().min(1).max(4096).nullable(),
    checkPublicIp: z.boolean(),
    launchAtLogin: z.boolean(),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

// No control characters: a newline would terminate the management command and inject another.
const noControl = (max: number) => z.string().max(max).regex(/^[^\x00-\x1f\x7f]*$/, 'Control characters are not allowed');

export const SecretInputSchema = z
  .object({
    username: noControl(256).optional(),
    password: noControl(1024),
    response: noControl(256).optional(),
  })
  .strict();

export const PathSchema = z.string().min(1).max(4096);
export const PathListSchema = z.array(PathSchema).min(1).max(50);

export const ImportRequestSchema = z
  .object({ path: PathSchema, name: z.string().trim().max(100), acceptDangerous: z.boolean() })
  .strict();
export const ImportRequestListSchema = z.array(ImportRequestSchema).min(1).max(50);

export const ConfigTextSchema = z.string().max(1024 * 1024);

export const ConnectOptionsSchema = z
  .object({ defaultRoute: z.enum(['take', 'skip']).optional(), replaceDefault: z.boolean().optional() })
  .strict();
