import type { Admin } from 'kafkajs'
import type { ConsumerOffsets } from '../application/ports.js'

/**
 * Offset consumer group lewat admin Kafka (Step 27, replay).
 *
 * Hanya group ANALITIK yang pernah disentuh — pemanggilnya menyebut groupId
 * dari config.ts. Group service lain tidak punya jalan ke sini.
 *
 * `Empty`: group ada, tanpa anggota — offset boleh diputar. `Dead`: group
 * belum pernah ada atau sudah dibuang broker — tidak ada offset untuk
 * dipertahankan, dan `resetOffsets` tetap menuliskan offset awal.
 *
 * Lambat: `resetOffsets` kafkajs menulis offset
 * lewat consumer SEMENTARA yang bergabung ke group, sekitar 8 detik per topik
 * di broker lokal (dijelaskan di Temuan Step 27). Enam topik ≈ 50 detik.
 * Topik diputar satu per satu: dua consumer sementara di group yang sama
 * saling memicu penyeimbangan ulang.
 */
const IDLE_STATES = new Set(['Empty', 'Dead'])

export function createKafkaOffsets(admin: Admin): ConsumerOffsets {
  return {
    async check(groupId) {
      const { groups } = await admin.describeGroups([groupId])
      const group = groups.find((candidate) => candidate.groupId === groupId)
      if (group === undefined || IDLE_STATES.has(group.state)) return { kind: 'idle' }

      return { kind: 'active', members: group.members.length, state: group.state }
    },

    async rewindToEarliest(groupId, topics) {
      for (const topic of topics) {
        await admin.resetOffsets({ groupId, topic, earliest: true })
      }
    },
  }
}
