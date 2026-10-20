// What `ssh-keygen -Y sign -n devnull-commit -f <dir>/signing.pub` printed on
// stdout (OpenSSH 8.9p1), signing through a scratch ssh-agent on a relative
// socket with throwaway keys made by `ssh-keygen -N ''`; the keys and the agent
// were deleted afterwards. ED25519 signed the payload below, which
// `ssh-keygen -Y check-novalidate -n devnull-commit` accepted; RSA (3072 bits)
// signed `x`.

export const SIGNED_PAYLOAD = '1760000000\n0123456789abcdef0123456789abcdef\n\nhello'

export const ED25519_SIGNATURE = [
  '-----BEGIN SSH SIGNATURE-----',
  'U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgmdy3kPXVsA62arYT4EiM3T/35l',
  'Yl613RIH3alFrE9mAAAAAOZGV2bnVsbC1jb21taXQAAAAAAAAABnNoYTUxMgAAAFMAAAAL',
  'c3NoLWVkMjU1MTkAAABAyOuCMaQfkY+0ZEGdRSfLXWhLwQVsUowcptoVU4KP+OVMT4x4lm',
  'k1NKhlwP+dmDkm4W4hrhLcfyVwqVQHrzhZDg==',
  '-----END SSH SIGNATURE-----',
  '',
].join('\n')

export const RSA_SIGNATURE = [
  '-----BEGIN SSH SIGNATURE-----',
  'U1NIU0lHAAAAAQAAAZcAAAAHc3NoLXJzYQAAAAMBAAEAAAGBAJtVwM4vorVjw/htkhH1HW',
  'rEKd5G+7E1l3z2s5lhP9tYQ6cshZYacIi0LsqDFQnb2XTopZCzGrak1rIUzov89paupJzX',
  '5yhP0j/oADlRlmIw5QhcdIJ/8ymcHwB3IS0lSFY6ojxtRdWmOIejYLar/lbUWkcEtgiGIz',
  'lJpnw6CrPuYGntld7o9dTLySKhqOHnfqOukDprNMjIoS5Bo6hUJ7mPNQToxIB6vnQDwy5b',
  'PcaEmK5vsAkcE7/EEDRN6rAj4stvULiu1RAyr95GfEeAOikqRjUJpR9xwusAafl+ESWJ2d',
  'Rqm7NLF6ety4XjbMPQe+iVgA5kVn7wlcKrhLXNVOi8ya4wgEHLwrljIppzFllmKbaE+IIn',
  'XCryD2v0DFMoRNJiI1AtJyQ0oNJD+enDtlRqMkmPMnjQmKYTkn9j79Dzwn8DDMLIvt72GN',
  'ZBDXG733yMnSO2PkUpMvimXXYqN4Y5o6VLmyPFE2umRlpfBohMyUN3XQfIaxWi9MMj9mB3',
  '6wAAAA5kZXZudWxsLWNvbW1pdAAAAAAAAAAGc2hhNTEyAAABlAAAAAxyc2Etc2hhMi01MT',
  'IAAAGAJ1t0FWfRRI7p5VB21wc4RIPdaOzY23Q+EZ3OsTNYa3atXrSC/8yYrgWdIuLwxL1Q',
  'BAUpP0EdJAT6W7ndQrDBsjsQzmwxDW2DZG49VQkXXaj4cm755i1YYnFY01FbA2mtU2rq5X',
  '/sEFcCgonMVsD+YXz+vWHH02RrV8LLa9HMjWC24r3sX7juVemfkTzQfACfP8HPTLFUMf7C',
  'YG36miganJa/XqKwW66ItnJCOyBxi8S4Nk6fxWMMaVGBmilOMpS7RINkzPeXTvM1eLssX0',
  'Rlbbz6aAz1lAnMYvAsej0E3hXngKPNvuwu2gBf3hdgV83KV+4F2m1uvXHgcYHIi4hDGflt',
  'CpFzLFeHvlB0puFyGa+9+NwzVkuULC5z7h1VM2a8NZDD8YR3vr7b4wcDzXZlbxr+CxHP2R',
  'GsTjSHc8Cb86DuDnQM2vD08XxyM9HHRBLl548dc3bsbXOPmRgzxXLF2ZYtNt4ywiZmZoxE',
  'K1zEpdjSYuzRiQ6zL8W/0LwjSEdV',
  '-----END SSH SIGNATURE-----',
  '',
].join('\n')
