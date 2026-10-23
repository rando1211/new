-- DAMG design-partner tenant: dealer, eight rooftops and the Pixel Motion feed.
-- Idempotent so it can be re-run safely. ADF inboxes stay null until confirmed
-- from DriveCentric; only Vista's is known.

insert into public.dealers (name, slug)
values ('Del Amo Motorsports Group', 'damg')
on conflict (slug) do update set name = excluded.name;

insert into public.rooftops (dealer_id, name, store_code, adf_inbox_email, site_url)
select d.id, r.name, r.store_code, r.adf_inbox_email, r.site_url
from public.dealers d
cross join (values
  ('Orange County (Santa Ana)',  'orange-county', null,                      'https://delamomotorsports.com'),
  ('Los Angeles (Paramount)',    'los-angeles',   null,                      'https://losangeles.delamomotorsports.com'),
  ('Long Beach',                 'long-beach',    null,                      'https://delamomotorsports.com'),
  ('Redondo Beach',              'redondo-beach', null,                      'https://delamomotorsports.com'),
  ('South Bay (Chula Vista)',    'south-bay',     null,                      'https://delamomotorsports.com'),
  ('Vista',                      'vista',         'vistaleads@delamoms.com', 'https://vista.delamomotorsports.com'),
  ('Victorville',                'victorville',   null,                      'https://delamomotorsports.com'),
  ('El Cajon Harley-Davidson',   'el-cajon-hd',   null,                      null)
) as r (name, store_code, adf_inbox_email, site_url)
where d.slug = 'damg'
on conflict (dealer_id, store_code) do update
  set name = excluded.name,
      adf_inbox_email = coalesce(public.rooftops.adf_inbox_email, excluded.adf_inbox_email),
      site_url = excluded.site_url;

insert into public.feeds (dealer_id, url, format, schedule)
select d.id,
       'https://api.dtm.pixelmotiondemo.com/api/v1/facebookCatalog/delamomotorsports.csv',
       'fb_catalog_csv',
       '0 * * * *'
from public.dealers d
where d.slug = 'damg'
on conflict (dealer_id, url) do nothing;
