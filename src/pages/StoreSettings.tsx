import { useEffect, useMemo, useRef, useState } from 'react'
import { AtSign, Image as ImageIcon, Plus, RotateCcw, Save, Store, Trash2, Upload } from 'lucide-react'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { Textarea } from '../components/ui/Textarea'
import { Button } from '../components/ui/Button'
import { useToast } from '../components/ui/useToast'
import AddProductModal from '../components/AddProductModal'
import { useProductStore, useSettingsStore, type StoreSettings as ShopSettings } from '../store/store'
import {
  BRAND_ADDRESS,
  BRAND_EMAIL,
  BRAND_EN,
  BRAND_INSTAGRAM,
  BRAND_LOGO,
  BRAND_OWNER_NAME,
  BRAND_PHONE_DISPLAY,
  BRAND_SUBTITLE,
  BRAND_WHATSAPP,
  setShopLogoDataUrl,
  toInstagramLink,
} from '../lib/brand'
import { uploadShopLogo } from '../lib/storage'
import { isSupabaseConfigured } from '../lib/supabase'
import {
  CARD_COLOR_PRESETS,
  DEFAULT_CARD_COLOR,
  applyShopTheme,
  isValidHex,
  normalizeHex,
  readCachedCardColor,
} from '../lib/shopTheme'

type FormState = {
  logoUrl: string
  ownerName: string
  name: string
  businessType: string
  phone: string
  shopContact: string
  email: string
  address: string
  instagramId: string
  cardColor: string
}

// Until the saved profile loads, fall back to the live brand values (which are
// themselves hydrated from the last saved profile) so the form is never blank.
const toForm = (settings: ShopSettings | null): FormState => ({
  logoUrl: settings?.logoUrl ?? '',
  ownerName: settings?.ownerName ?? BRAND_OWNER_NAME,
  name: settings?.name ?? BRAND_EN,
  businessType: settings?.businessType ?? BRAND_SUBTITLE,
  phone: settings?.phone ?? BRAND_PHONE_DISPLAY,
  shopContact: settings?.shopContact ?? BRAND_WHATSAPP,
  email: settings?.email ?? BRAND_EMAIL,
  address: settings?.address ?? BRAND_ADDRESS,
  instagramId: settings?.instagramId ?? (BRAND_INSTAGRAM ? `@${BRAND_INSTAGRAM}` : ''),
  cardColor: normalizeHex(settings?.cardColor ?? '') || readCachedCardColor(),
})

const digitsOf = (value: string) => value.replace(/\D/g, '')

const validate = (form: FormState): Partial<Record<keyof FormState, string>> => {
  const errors: Partial<Record<keyof FormState, string>> = {}
  if (!form.ownerName.trim()) errors.ownerName = 'Full name is required'
  if (!form.name.trim()) errors.name = 'Shop name is required'

  const phoneDigits = digitsOf(form.phone)
  if (!phoneDigits) errors.phone = 'Phone number is required'
  else if (phoneDigits.length < 10 || phoneDigits.length > 15) errors.phone = 'Enter a valid phone number'

  const contactDigits = digitsOf(form.shopContact)
  if (contactDigits && (contactDigits.length < 10 || contactDigits.length > 15)) {
    errors.shopContact = 'Enter a valid contact number'
  }

  if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) {
    errors.email = 'Enter a valid email address'
  }

  if (!form.address.trim()) errors.address = 'Shop address is required'

  if (form.instagramId.trim() && !/^@?[A-Za-z0-9._]{1,30}$/.test(form.instagramId.trim())) {
    errors.instagramId = 'Use letters, numbers, dots or underscores'
  }

  if (!isValidHex(form.cardColor)) errors.cardColor = 'Pick a valid colour'
  return errors
}

const SectionTitle = ({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) => (
  <div className="mb-4 flex items-start gap-2.5">
    <span className="mt-0.5 text-shopCard">{icon}</span>
    <div>
      <h3 className="text-[14px] font-black text-[#111111]">{title}</h3>
      {hint && <p className="text-[11px] font-semibold text-gray-500">{hint}</p>}
    </div>
  </div>
)

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-gray-500">{label}</span>
    {children}
  </label>
)

export default function StoreSettings() {
  const { settings, loading, saving, fetchSettings, saveSettings } = useSettingsStore()
  const { products, fetchProducts } = useProductStore()
  const { toast } = useToast()

  const [form, setForm] = useState<FormState>(() => toForm(settings))
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [logoPreview, setLogoPreview] = useState<string>('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [addSareeOpen, setAddSareeOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Re-sync the editable form from the store whenever a fresh `settings`
  // object arrives (adjusted during render rather than in an effect, per
  // https://react.dev/learn/you-might-not-need-an-effect).
  const [prevSettings, setPrevSettings] = useState(settings)
  if (settings !== prevSettings) {
    setPrevSettings(settings)
    setForm(toForm(settings))
    setLogoPreview('')
    setLogoFile(null)
  }

  useEffect(() => {
    if (!settings) void fetchSettings()
  }, [settings, fetchSettings])

  // Live preview of the card colour; reverted from the saved value on reset.
  useEffect(() => {
    if (isValidHex(form.cardColor)) applyShopTheme(form.cardColor)
  }, [form.cardColor])

  const shownLogo = logoPreview || form.logoUrl || BRAND_LOGO
  const instagramLink = useMemo(() => toInstagramLink(form.instagramId), [form.instagramId])

  const sareeCategories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const product of products) {
      const category = (product.category || '').trim()
      if (category) counts.set(category, (counts.get(category) || 0) + 1)
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [products])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }))
    setErrors(prev => ({ ...prev, [key]: undefined }))
  }

  const handlePickLogo = (file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Logo must be an image file')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Logo must be smaller than 2MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setLogoPreview(String(reader.result || ''))
      setLogoFile(file)
    }
    reader.readAsDataURL(file)
  }

  const handleRemoveLogo = () => {
    setLogoPreview('')
    setLogoFile(null)
    set('logoUrl', '')
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleReset = () => {
    setForm(toForm(settings))
    setErrors({})
    setLogoPreview('')
    setLogoFile(null)
    if (fileRef.current) fileRef.current.value = ''
    applyShopTheme(settings?.cardColor || readCachedCardColor())
  }

  const handleSave = async () => {
    const nextErrors = validate(form)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      toast.error('Please fix the highlighted fields')
      return
    }

    let logoUrl = form.logoUrl
    if (logoFile) {
      setUploading(true)
      try {
        // Reuse the app's existing image storage when Supabase is configured;
        // otherwise keep the inline data URL so the logo still persists.
        logoUrl = isSupabaseConfigured ? await uploadShopLogo(logoFile) : logoPreview
      } catch (err) {
        setUploading(false)
        toast.error(err instanceof Error ? err.message : 'Logo upload failed')
        return
      }
      setUploading(false)
    }

    // Keep a data-URL copy so generated PDFs can embed the logo synchronously.
    setShopLogoDataUrl(logoUrl ? (logoPreview || null) : null)

    const result = await saveSettings({
      ...form,
      logoUrl,
      cardColor: normalizeHex(form.cardColor),
    })

    if (!result.ok) {
      toast.error(result.error || 'Could not save store settings')
      return
    }
    toast.success('Store settings saved')
  }

  const busy = saving || uploading

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-[#111111]">Store Settings</h2>
          <p className="text-[12px] font-semibold text-gray-500">
            Shop profile used across invoices, receipts and the app header.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" iconLeft={<RotateCcw size={14} />} onClick={handleReset} disabled={busy}>
            Reset
          </Button>
          <Button iconLeft={<Save size={14} />} loading={busy} onClick={() => void handleSave()}>
            Save
          </Button>
        </div>
      </div>

      {loading && !settings && <p className="text-[12px] font-bold text-gray-500">Loading shop profile…</p>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* SHOP PROFILE */}
        <Card padding="lg">
          <SectionTitle icon={<Store size={16} />} title="Shop Profile" hint="Logo, owner and shop name" />
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-shopSoft bg-white">
                {shownLogo ? (
                  <img src={shownLogo} alt="Shop logo preview" className="h-full w-full object-contain" />
                ) : (
                  <ImageIcon size={22} className="text-gray-300" />
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handlePickLogo(e.target.files?.[0] ?? null)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft={<Upload size={13} />}
                  onClick={() => fileRef.current?.click()}
                >
                  {shownLogo ? 'Replace Logo' : 'Upload Logo'}
                </Button>
                {shownLogo && (
                  <Button variant="danger" size="sm" iconLeft={<Trash2 size={13} />} onClick={handleRemoveLogo}>
                    Remove
                  </Button>
                )}
              </div>
            </div>

            <Field label="Full Name">
              <Input
                value={form.ownerName}
                onChange={(e) => set('ownerName', e.target.value)}
                placeholder="SHANMUGAPRIYA"
                error={errors.ownerName}
              />
            </Field>
            <Field label="Shop Name">
              <Input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="SRI SAKTHI PUGAZH TEX"
                error={errors.name}
              />
            </Field>
            <Field label="Business Type">
              <Input
                value={form.businessType}
                onChange={(e) => set('businessType', e.target.value)}
                placeholder="SAREE WHOLESALE & RETAIL"
              />
            </Field>
          </div>
        </Card>

        {/* CONTACT DETAILS */}
        <Card padding="lg">
          <SectionTitle icon={<Store size={16} />} title="Contact Details" hint="Shop contact only — customer details are unaffected" />
          <div className="space-y-4">
            <Field label="Phone Number">
              <Input
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                placeholder="73586 70411"
                inputMode="tel"
                error={errors.phone}
              />
            </Field>
            <Field label="Shop Contact Number">
              <Input
                value={form.shopContact}
                onChange={(e) => set('shopContact', e.target.value)}
                placeholder="73586 70411"
                inputMode="tel"
                error={errors.shopContact}
              />
            </Field>
            <Field label="Email ID">
              <Input
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
                placeholder="shop@example.com"
                inputMode="email"
                error={errors.email}
              />
            </Field>
          </div>
        </Card>

        {/* SHOP INFORMATION */}
        <Card padding="lg">
          <SectionTitle icon={<Store size={16} />} title="Shop Information" hint="Address and social profile" />
          <div className="space-y-4">
            <Field label="Shop Address">
              <Textarea
                rows={4}
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                placeholder={'NO. 185, LE SITHARAS SQUARE, MUDICHUR ROAD,\nNEXT TO HP PETROL PUMP, MUDICHUR,\nCHENNAI - 600048'}
                error={errors.address}
              />
            </Field>
            <Field label="Instagram ID">
              <Input
                value={form.instagramId}
                onChange={(e) => set('instagramId', e.target.value)}
                placeholder="@srisakthipugazhtex"
                leftIcon={<AtSign size={14} />}
                error={errors.instagramId}
              />
            </Field>
            {form.instagramId.trim() && (
              <a
                href={instagramLink}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-[11px] font-bold text-shopCard hover:underline"
              >
                {instagramLink}
              </a>
            )}
          </div>
        </Card>

        {/* APPEARANCE */}
        <Card padding="lg">
          <SectionTitle
            icon={<Store size={16} />}
            title="Appearance"
            hint="Preferred colour theme — selected card colour + white"
          />
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {CARD_COLOR_PRESETS.map(preset => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => set('cardColor', preset)}
                  aria-label={`Card colour ${preset}`}
                  className={[
                    'h-9 w-9 rounded-xl border-2 transition-transform',
                    normalizeHex(form.cardColor) === preset ? 'border-[#111111] scale-105' : 'border-white',
                  ].join(' ')}
                  style={{ backgroundColor: preset }}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-gray-500">
                  Custom Colour
                </span>
                <input
                  type="color"
                  value={normalizeHex(form.cardColor) || DEFAULT_CARD_COLOR}
                  onChange={(e) => set('cardColor', e.target.value)}
                  className="h-11 w-16 cursor-pointer rounded-xl border border-shopSoft bg-white p-1"
                />
              </label>
              <div className="w-40">
                <Input
                  value={form.cardColor}
                  onChange={(e) => set('cardColor', e.target.value)}
                  placeholder="#8F1402"
                  error={errors.cardColor}
                />
              </div>
            </div>
            <div className="rounded-2xl border border-shopSoft bg-white p-4">
              <div className="rounded-xl bg-shopCard p-3 text-onCard">
                <p className="text-[12px] font-black uppercase tracking-wider">Card preview</p>
                <p className="text-[11px] font-semibold opacity-90">Selected colour + white stays the app theme.</p>
              </div>
              <p className="mt-3 text-[11px] font-bold text-gray-500">
                White backgrounds, layout and components are unchanged — only the accent colour follows this setting.
              </p>
            </div>
          </div>
        </Card>

        {/* PRODUCT CATALOGUE */}
        <Card padding="lg" className="xl:col-span-2">
          <SectionTitle
            icon={<Store size={16} />}
            title="Saree Catalogue"
            hint="Uses the existing product & category system — nothing is duplicated"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" iconLeft={<Plus size={13} />} onClick={() => setAddSareeOpen(true)}>
              Add Saree to Catalogue
            </Button>
            <span className="text-[11px] font-bold text-gray-500">
              {products.length} item{products.length === 1 ? '' : 's'} in the catalogue
            </span>
          </div>
          {sareeCategories.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {sareeCategories.map(([category, count]) => (
                <span
                  key={category}
                  className="rounded-full border border-shopSoft bg-shopCard/10 px-3 py-1 text-[11px] font-black text-shopCard"
                >
                  {category} · {count}
                </span>
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] font-semibold text-gray-500">
            Saree name, category, image, price, fabric and stock are managed on the existing Inventory screen.
          </p>
        </Card>
      </div>

      <AddProductModal
        isOpen={addSareeOpen}
        onClose={() => setAddSareeOpen(false)}
        onSuccess={() => {
          setAddSareeOpen(false)
          void fetchProducts(true)
        }}
      />
    </div>
  )
}
