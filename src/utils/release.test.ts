import assert from 'node:assert/strict';
import test from 'node:test';
import { dateKeyInTz, isReleased, releaseAt } from './release.ts';

test('北京时间日期键在 16:00Z 切换到下一天', () => {
  assert.equal(dateKeyInTz(new Date('2026-10-20T15:59:59Z')), '2026-10-20');
  assert.equal(dateKeyInTz(new Date('2026-10-20T16:00:00Z')), '2026-10-21');
});

test('日期键对纯日期与带时区的时间戳一致', () => {
  assert.equal(dateKeyInTz(new Date('2026-10-21')), '2026-10-21');
  assert.equal(dateKeyInTz(new Date('2026-10-21T00:00:00+08:00')), '2026-10-21');
  assert.equal(dateKeyInTz(new Date('2026-10-20T23:30:00-05:00')), '2026-10-21');
});

test('北京当天零点前不放行，零点起放行', () => {
  const postDate = new Date('2026-10-21');
  assert.equal(isReleased(postDate, new Date('2026-10-20T15:59:59Z')), false);
  assert.equal(isReleased(postDate, new Date('2026-10-20T16:00:00Z')), true);
});

test('releaseAt 是北京时间当天 00:00', () => {
  assert.equal(
    releaseAt(new Date('2026-10-21')).toISOString(),
    '2026-10-20T16:00:00.000Z',
  );
  assert.equal(
    releaseAt(new Date('2026-10-21T23:59:00+08:00')).toISOString(),
    '2026-10-20T16:00:00.000Z',
  );
});

test('跨年边界按北京时间计算', () => {
  assert.equal(dateKeyInTz(new Date('2026-12-31T15:59:59Z')), '2026-12-31');
  assert.equal(dateKeyInTz(new Date('2026-12-31T16:00:00Z')), '2027-01-01');
  assert.equal(
    releaseAt(new Date('2026-12-31T16:00:00Z')).toISOString(),
    '2026-12-31T16:00:00.000Z',
  );
});

test('闰日边界按北京时间计算', () => {
  assert.equal(dateKeyInTz(new Date('2028-02-28T15:59:59Z')), '2028-02-28');
  assert.equal(dateKeyInTz(new Date('2028-02-28T16:00:00Z')), '2028-02-29');
  assert.equal(
    releaseAt(new Date('2028-02-28T16:00:00Z')).toISOString(),
    '2028-02-28T16:00:00.000Z',
  );
});
