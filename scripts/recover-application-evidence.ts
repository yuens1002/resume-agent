import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { recoverApplicationEvidence } from '../src/lib/application-evidence-recovery.js'
import { supabase } from '../src/lib/supabase.js'

const RecoveryManifestSchema = z.object({
  recovery_id: z.string().uuid(),
  application_id: z.string().uuid(),
  expected_company: z.string().min(1).max(500),
  expected_role: z.string().min(1).max(500),
  resume_id: z.string().uuid(),
  resume_content_file: z.string().min(1),
  source_ref: z.string().regex(/^job-hunt-agent:output:[A-Za-z0-9._-]{1,200}$/),
  docx_file: z.string().min(1).optional(),
  pdf_file: z.string().min(1).optional(),
}).strict().refine(manifest => manifest.docx_file || manifest.pdf_file, {
  message: 'At least one artifact file is required',
})

function manifestArgument(argv: string[]) {
  if (argv.length !== 2 || argv[0] !== '--manifest') {
    throw new Error('Usage: tsx scripts/recover-application-evidence.ts --manifest <private-json-file>')
  }
  return resolve(argv[1])
}

async function readOptionalArtifact(manifestDirectory: string, path: string | undefined) {
  return path ? new Uint8Array(await readFile(resolve(manifestDirectory, path))) : undefined
}

const manifestPath = manifestArgument(process.argv.slice(2))
const manifestDirectory = dirname(manifestPath)
const manifest = RecoveryManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
const resumeContent = z.record(z.unknown()).parse(JSON.parse(
  await readFile(resolve(manifestDirectory, manifest.resume_content_file), 'utf8'),
))

const result = await recoverApplicationEvidence({
  recovery_id: manifest.recovery_id,
  application_id: manifest.application_id,
  expected_company: manifest.expected_company,
  expected_role: manifest.expected_role,
  resume_id: manifest.resume_id,
  resume_content: resumeContent,
  source_ref: manifest.source_ref,
  docx_bytes: await readOptionalArtifact(manifestDirectory, manifest.docx_file),
  pdf_bytes: await readOptionalArtifact(manifestDirectory, manifest.pdf_file),
}, {
  readApplication: async applicationId => {
    const { data, error } = await supabase.from('job_applications')
      .select('id, company, role, stage').eq('id', applicationId).maybeSingle()
    return { data, error }
  },
  upload: async (path, bytes, contentType) => {
    const { error } = await supabase.storage.from('resume-artifacts')
      .upload(path, Buffer.from(bytes), { contentType, upsert: false })
    return { error }
  },
  download: async path => {
    const { data, error } = await supabase.storage.from('resume-artifacts').createSignedUrl(path, 60)
    if (error || !data?.signedUrl) return { data: null, error: error ?? new Error('missing signed artifact URL') }
    try {
      const response = await fetch(data.signedUrl)
      return response.ok && response.body
        ? { data: response.body, error: null }
        : { data: null, error: new Error(`artifact download failed (${response.status})`) }
    } catch (downloadError) {
      return { data: null, error: downloadError }
    }
  },
  recover: async args => {
    const { data, error } = await supabase.rpc('recover_application_resume_version', args)
    return { data, error }
  },
  readback: async recoveryId => {
    const { data, error } = await supabase.from('application_resume_recovery_imports')
      .select('recovery_id, application_id, resume_id, source_ref, recorded_at, original_generated_at, application_resumes!inner(resume_content, docx_url, docx_hash, pdf_url, pdf_hash, is_submitted)')
      .eq('recovery_id', recoveryId).maybeSingle()
    if (error || !data) return { data: null, error }
    const { application_resumes: relatedResume, ...recovery } = data
    const resume = Array.isArray(relatedResume) ? relatedResume[0] : relatedResume
    return { data: resume ? { ...recovery, ...resume } : null, error: null }
  },
})

// The administrative receipt intentionally contains no resume content, file
// bytes, local paths, signed URLs, or service credentials.
console.log(JSON.stringify(result, null, 2))
if (result.status === 'refused') process.exitCode = 1
