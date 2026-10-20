// Public key lines of throwaway keys made for these tests with
// `ssh-keygen -N ''` (OpenSSH 8.9p1); their private halves were never kept.
// Each fingerprint is what `ssh-keygen -lf` printed for that line.

export const ED25519 = {
  line: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA4H1QPCRYfgrYDDcpgWNeu3xFkvIYWXaM4D9Q5rd1a+',
  comment: 'devnull-test-fixture',
  fingerprint: 'SHA256:KaiETb8PaDoq0OTWwpj7L3ZsS90YAdrSFdZ9eCugyd8',
} as const

export const RSA = {
  line: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCutt5sp8/JyJsNbs1QfxVSYlBESSoIatU2lYv4KlNfKX5dR7NPpqg6b3FJSw76+TReD1k2MwFdTn5Fn5UKQpnXloGCZkj/oNI5DO4nkH/kKO3EXkrrzCmMN184/nPa7aURS5BpxK10jbQBVLLmx7IvgO6LjNzhYAA8TEQ/Gd/WpYVG2wuPMjIsXGWri3aWbFnX6Bx9vRiJVb4B/YM/UU1Ddb/R6VdP6K14thgd1Lh7NqFKOfnYzOvidT3X9IZvND4oiynVz/M+WkTxqvtlUfVZ5sb+Y+vV7aT157QIMT1AACSw/Oso52PeaXj0Nh/lkkUuRArxRIPugrtdnUHoYZ4e7rehZCalvf38wwV8JBOpTUZrW0zegHE+YhH2JPBvP02gfAUlOEa8GehsBQoaS4X+gnmCv9PVvquJgwPaCGyIDIyDZ6gT27KuMofyCEu3sZZcDPrP90hsFA1c6n+mqbzfCFXiRN3vaqRgDgWrNkBoJuoyha0rSTWGXYchC/a3fNU=',
  comment: 'rsa fixture',
  fingerprint: 'SHA256:NYFrKhP9gaZrkQspw0QPyOVUVoaj02Yv+PlcB386tt4',
} as const

export const ECDSA = {
  line: 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPp6WTz1neiE204JCwbmtmgc3Cljoog7KOLtJT5arFAdNdPoTG3X9glw8ksdS1pUzbrMUtLSJeOL4q4cHMRe9cA=',
  comment: 'ecdsa fixture',
} as const

// 1024 bits: below dev-null.sh's 2048-bit minimum (SshPublicKey::MinimumRsaBits).
export const RSA_1024 = {
  line: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQD2uu5W/na1dx3RKU0jJDCJ0qtF36qoxucr4jWqhl3K6r0rRyEwqAeivigS1LWQ50xfFDfLMYedpzGAWC1saNOh2vGQKRwAqUIaRuFh0PX3MhxYGYXUkL6SpSoja16q984+pSX99UPNLwNpKiMdNDbfynJdZ8SXQX1sd5u8XiJIgw==',
  comment: 'rsa 1024 fixture',
  fingerprint: 'SHA256:sK7Y6jg6Jr00RbJq5ZMTurh9QdNaf/UggVVaJY4U5Jc',
} as const

// Exactly 2048 bits: the smallest RSA key dev-null.sh accepts.
export const RSA_2048 = {
  line: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDAfiVs9o4YXG/AHs1l+gxgQ5DF7RGFEjTBhcB6jepnohdyE+nVI6+RhPjisgUfhXtF4IuPTP7wRqriu2qPHZtjMEwANXdUFZffvmt+LztdPyR0jAVTLGrw1A+WI46uGjgDNGKhxUortpieESiHwBwldbj0e7czx1xgYW3eQoPMxryO0SMsyhrLb3qdNEADPF19LqknLWFyOEp3w4F4Gu8B8x2JPh6+de0H8lXy+rrt6e2ZCJ4on1We0sK7T4xZTP3mKuZMeh8aNpfRvtFyDU0/EQgigJ0Grh9L+DSE4qTmIaUvjY4OQoCULErfswIMno+WtqiNRrM/2AOEZxkbfSrB',
  comment: 'rsa 2048 fixture',
  fingerprint: 'SHA256:s/YLAINID6mZIv7CNQQtF6t2dPUtqn9YQm9aAQsDs4A',
} as const
