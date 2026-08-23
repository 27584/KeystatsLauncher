-- ============================================================================
-- KeyStatsLauncher 后端 Schema
-- 项目：健康鼠标
-- 目标：以本文件可完整复现后端（表结构 + 安全策略 + 函数）。
--
-- 说明：
--  * 客户端使用新版 Publishable Key（对应 "anon" 角色），而非旧版 anon key。
--  * 账号体系（微信登录）尚未接入。当前以输入的 user_id 作为账号标识占位，
--    未来小程序登录后，将用户名/微信 openid 作为 users.id，并以上下文
--    auth.uid() 替代传入的 user_id（文档标注对应改造点）。
--  * 安全模型：所有表启用 RLS，且对 anon/authenticated 不开放任何直接 DML，
--    数据读写一律经由下面的 SECURITY DEFINER 函数完成，最小化暴露面。
--    正式接入小程序后，可把函数内的 user_id 校验替换为 auth.uid() 校验。
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 用户表：账号标识（当前占位 = 微信 id / 输入 id）
-- ---------------------------------------------------------------------------
create table if not exists public.users (
    id          text primary key,           -- 微信 openid / 临时登录 id（占位）
    created_at  timestamptz not null default now()
);

comment on table public.users is '用户。当前以输入的 id 占位，未来接入微信登录后 id 即微信 openid。';

-- ---------------------------------------------------------------------------
-- 设备表：一台运行 KeyStats + 启动器的电脑（支持一用户绑定多设备）
-- ---------------------------------------------------------------------------
create table if not exists public.devices (
    device_uuid          uuid primary key default gen_random_uuid(),
    user_id              text references public.users(id) on delete cascade,
    is_bound             boolean not null default false,
    device_name          text,                       -- 设备名称（上传时上报，网页端展示用）
    bind_code            text,                       -- 6 位数字/字母验证码（绑定用，成功后清除）
    bind_code_expires_at timestamptz,                -- 验证码有效期（当前 5 分钟）
    device_secret        text not null,              -- 设备密钥：上传时必须携带，防止匿名伪造
    bound_at             timestamptz,
    created_at           timestamptz not null default now(),
    last_seen_at         timestamptz                 -- 最近一次上传时间
);

-- 兼容旧表：若已存在 devices 但缺 device_name 列，则补齐（保证可重复执行）
alter table public.devices add column if not exists device_name text;

create index if not exists devices_user_id_idx   on public.devices (user_id);
create index if not exists devices_bind_code_idx on public.devices (bind_code) where bind_code is not null;

comment on table public.devices is '设备。一用户多设备；未绑定时仅由验证码+密钥标记。';

-- ---------------------------------------------------------------------------
-- 健康快照表：每次上传追加一条（不覆盖），记录某时刻键鼠使用累计/瞬时指标
-- 剔除 appStats；按键分布 key_press_counts 以 jsonb 保留以便按需分析。
-- ---------------------------------------------------------------------------
create table if not exists public.health_snapshots (
    id               bigint generated always as identity primary key,
    device_uuid      uuid not null references public.devices(device_uuid) on delete cascade,
    user_id          text not null references public.users(id) on delete cascade,
    uploaded_at      timestamptz not null default now(),   -- 上传时间
    stats_date       date not null,                          -- 数据所属日期
    key_presses      int not null default 0,
    key_press_counts jsonb not null default '{}'::jsonb,
    left_clicks      int not null default 0,
    right_clicks     int not null default 0,
    middle_clicks    int not null default 0,
    side_back_clicks int not null default 0,
    side_forward_clicks int not null default 0,
    mouse_distance   double precision not null default 0,
    scroll_distance  double precision not null default 0,
    peak_kps         double precision not null default 0,
    peak_cps         double precision not null default 0
);

create index if not exists health_snapshots_user_date_idx
    on public.health_snapshots (user_id, stats_date);
create index if not exists health_snapshots_device_idx
    on public.health_snapshots (device_uuid);

comment on table public.health_snapshots is '键鼠健康指标快照，每次上传追加一条（时间序列）。';

-- ---------------------------------------------------------------------------
-- RLS：启用并对 anon/authenticated 禁止任何直接 DML，仅允许通过下方函数
-- ---------------------------------------------------------------------------
alter table public.users           enable row level security;
alter table public.devices         enable row level security;
alter table public.health_snapshots enable row level security;

-- 阻断底表直接访问（Publishable Key 无账号上下文，不允许触碰原始表）。
-- RLS 策略无 IF NOT EXISTS，故用 DO 块按策略名判断，已存在则跳过（保证可重复执行）。
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'block_direct_users') then
        execute 'create policy "block_direct_users" on public.users for all to anon using (false) with check (false)';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'devices' and policyname = 'block_direct_devices') then
        execute 'create policy "block_direct_devices" on public.devices for all to anon using (false) with check (false)';
    end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 函数（SECURITY DEFINER：以函数所有者身份执行，绕过 RLS，但只暴露最小操作）
-- 默认 PUBLIC 拥有 EXECUTE，配合 Publishable Key 使用。调用方必须带设备密钥或绑定码。
-- ---------------------------------------------------------------------------

-- 1) 注册一台新设备（启动器首次运行、未绑定时调用）
--    入参：bind_code（6 位验证码）、device_secret（设备密钥）、device_name（设备名称）
--    出参：device_uuid（客户端应保存，用于后续上传）
create or replace function public.register_device(p_bind_code text, p_device_secret text, p_device_name text)
returns uuid
language sql volatile security definer set search_path = public
as $$
    insert into public.devices (bind_code, bind_code_expires_at, device_secret, device_name)
    values (p_bind_code, now() + interval '5 minutes', p_device_secret, p_device_name)
    returning device_uuid;
$$;

-- 2) 为已注册未绑定的设备更换验证码（绑定窗口重开时调用，避免重复注册产生多余设备行）
--    入参：p_device_uuid、p_device_secret、p_bind_code（新生成的 6 位验证码）
--    返回：是否成功（设备存在且密钥匹配）
create or replace function public.refresh_bind_code(
    p_device_uuid uuid,
    p_device_secret text,
    p_bind_code text
)
returns boolean
language sql volatile security definer set search_path = public
as $$
    update public.devices d
       set bind_code = p_bind_code,
           bind_code_expires_at = now() + interval '5 minutes'
     where d.device_uuid = p_device_uuid
       and d.device_secret = p_device_secret
       and d.is_bound = false
     returning true;
$$;

-- 3) 绑定设备到用户（网页端：登录后输入验证码，将设备 uuid 关联到 user_id）
--    入参：bind_code（6 位验证码）、user_id
--    返回：绑定成功的设备 uuid；验证码无效/过期/已使用则返回 NULL
--    注意：网页端登录仅本地占位，尚未建 users 行；此处自动 upsert 用户占位记录。
create or replace function public.bind_device(p_bind_code text, p_user_id text)
returns uuid
language plpgsql volatile security definer set search_path = public
as $$
declare
    v_uuid uuid;
begin
    -- 用户占位：不存在则创建（账号体系接入前，user_id 即登录 id）
    insert into public.users(id) values (p_user_id) on conflict (id) do nothing;

    update public.devices d
       set user_id           = p_user_id,
           is_bound          = true,
           bound_at          = now(),
           bind_code         = null,
           bind_code_expires_at = null
     where d.bind_code = p_bind_code
       and d.bind_code_expires_at > now()
       and d.is_bound = false
     returning d.device_uuid into v_uuid;

    return v_uuid;
end;
$$;

-- 4) 上传健康快照（启动器每 5 分钟调用一次；仅已绑定设备允许）
--    入参：device_uuid、device_secret、device_name（当前设备名称，用于网页展示）、stats_date、以及各指标
--    内部校验：设备存在、密钥匹配、且已绑定（user_id 非空）
create or replace function public.upload_snapshot(
    p_device_uuid uuid,
    p_device_secret text,
    p_device_name text,
    p_stats_date date,
    p_key_presses int,
    p_key_press_counts jsonb,
    p_left_clicks int,
    p_right_clicks int,
    p_middle_clicks int,
    p_side_back_clicks int,
    p_side_forward_clicks int,
    p_mouse_distance double precision,
    p_scroll_distance double precision,
    p_peak_kps double precision,
    p_peak_cps double precision
)
returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
    v_user_id text;
begin
    select d.user_id into v_user_id
      from public.devices d
     where d.device_uuid = p_device_uuid
       and d.device_secret = p_device_secret
       and d.is_bound = true;

    if v_user_id is null then
        raise exception 'device_not_bound_or_secret_mismatch';
    end if;

    insert into public.health_snapshots (
        device_uuid, user_id, stats_date, key_presses, key_press_counts,
        left_clicks, right_clicks, middle_clicks, side_back_clicks, side_forward_clicks,
        mouse_distance, scroll_distance, peak_kps, peak_cps, uploaded_at
    ) values (
        p_device_uuid, v_user_id, p_stats_date, p_key_presses, p_key_press_counts,
        p_left_clicks, p_right_clicks, p_middle_clicks, p_side_back_clicks, p_side_forward_clicks,
        p_mouse_distance, p_scroll_distance, p_peak_kps, p_peak_cps, now()
    );

    update public.devices d
       set last_seen_at = now(),
           device_name  = coalesce(p_device_name, d.device_name)
     where d.device_uuid = p_device_uuid;
end;
$$;

-- 5) 查询设备是否已绑定（启动器绑定页轮询用）
create or replace function public.get_device_status(p_device_uuid uuid, p_device_secret text)
returns boolean
language sql stable security definer set search_path = public
as $$
    select coalesce((
        select d.is_bound from public.devices d
         where d.device_uuid = p_device_uuid and d.device_secret = p_device_secret
    ), false);
$$;

-- 6) 查询某用户的全部设备（网页端登录后展示设备列表）
create or replace function public.get_user_devices(p_user_id text)
returns setof public.devices
language sql stable security definer set search_path = public
as $$
    select * from public.devices d where d.user_id = p_user_id order by d.bound_at nulls last;
$$;

-- 7) 查询某用户近 N 天健康快照（网页端图表数据源）
--    未来改造：p_user_id 改为从 auth.uid() 取值，避免伪造他人数据。
--    p_device_uuid 可选：传入则只返回该设备的数据（看板切换设备时用）。
create or replace function public.get_health_snapshots(p_user_id text, p_days int default 30, p_device_uuid uuid default null)
returns setof public.health_snapshots
language sql stable security definer set search_path = public
as $$
    select s.*
      from public.health_snapshots s
     where s.user_id = p_user_id
       and (p_device_uuid is null or s.device_uuid = p_device_uuid)
       and s.stats_date >= (current_date - (p_days - 1))
     order by s.uploaded_at asc;
$$;

-- ---------------------------------------------------------------------------
-- 权限：确保 anon(Publishable Key)/authenticated 无法改写底表
-- ---------------------------------------------------------------------------
revoke all on table public.users, public.devices, public.health_snapshots from anon, authenticated;

-- 确保函数可被客户端调用（默认 PUBLIC EXECUTE；这里显式保证）
grant execute on function public.register_device(text, text, text) to anon, authenticated;
grant execute on function public.refresh_bind_code(uuid, text, text) to anon, authenticated;
grant execute on function public.bind_device(text, text) to anon, authenticated;
grant execute on function public.upload_snapshot(
    uuid, text, text, date, int, jsonb, int, int, int, int, int, double precision, double precision, double precision, double precision
) to anon, authenticated;
grant execute on function public.get_device_status(uuid, text) to anon, authenticated;
grant execute on function public.get_user_devices(text) to anon, authenticated;
grant execute on function public.get_health_snapshots(text, int, uuid) to anon, authenticated;