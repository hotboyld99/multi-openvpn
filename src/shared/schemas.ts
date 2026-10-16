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
