import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { CheckCircle, LogIn, LogOut, ChevronLeft } from 'lucide-react'
import { BRAND_EN, BRAND_LOGO } from '../lib/brand'

interface Staff {
  id: string
  name: string
  role: string
  is_active: boolean
}

interface AttendanceRecord {
  id: string
  staff_id: string
  date: string
  status: string
  clock_in: string | null
  clock_out: string | null
}

type Step = 'select' | 'punch' | 'done'

function formatTime(ts: string | null) {
  if (!ts) return null
  return new Date(ts).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: true })
}

function getTodayLocal() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

interface StaffPunchProps {
  embedded?: boolean
}

export default function StaffPunch({ embedded = false }: StaffPunchProps) {
  const [step, setStep] = useState<Step>('select')
  const [staff, setStaff] = useState<Staff[]>([])
  const [selectedStaff, setSelectedStaff] = useState<Staff | null>(null)
  const [todayRecord, setTodayRecord] = useState<AttendanceRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const today = getTodayLocal()
  const currentTime = new Date().toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: true })
  const currentDate = new Date().toLocaleDateString('en-MY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  useEffect(() => {
    const fetchStaff = async () => {
      setLoading(true)
      const { data } = await supabase.from('staff').select('id, name, role, is_active').eq('is_active', true).order('name')
      if (data) setStaff(data as Staff[])
      setLoading(false)
    }
    void fetchStaff()
  }, [])

  const selectStaff = async (s: Staff) => {
    setSelectedStaff(s)
    setLoading(true)
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('staff_id', s.id)
      .eq('date', today)
      .maybeSingle()
    setTodayRecord(data as AttendanceRecord | null)
    setLoading(false)
    setStep('punch')
  }

  const punchIn = async () => {
    if (!selectedStaff) return
    setSaving(true)
    setNotice('')
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('attendance')
      .upsert({ staff_id: selectedStaff.id, date: today, status: 'present', clock_in: now }, { onConflict: 'staff_id,date' })
      .select()
      .maybeSingle()
    if (error) { console.error('Punch in failed:', error); setNotice(error.message || 'Something went wrong. Please try again.') }
    else { setTodayRecord(data as AttendanceRecord); setStep('done'); setNotice('punch_in') }
    setSaving(false)
  }

  const punchOut = async () => {
    if (!selectedStaff || !todayRecord) return
    setSaving(true)
    setNotice('')
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('attendance')
      .update({ clock_out: now })
      .eq('staff_id', selectedStaff.id)
      .eq('date', today)
      .select()
      .maybeSingle()
    if (error) { console.error('Punch out failed:', error); setNotice(error.message || 'Something went wrong. Please try again.') }
    else { setTodayRecord(data as AttendanceRecord); setStep('done'); setNotice('punch_out') }
    setSaving(false)
  }

  const reset = () => { setStep('select'); setSelectedStaff(null); setTodayRecord(null); setNotice('') }

  const inner = (
    <div className={embedded ? 'p-4 sm:p-6 space-y-5' : 'flex-1 flex flex-col px-4 py-6 max-w-2xl mx-auto w-full'}>

      {/* STEP: SELECT */}
      {step === 'select' && (
        <>
          <div className={embedded ? 'mb-5' : 'mb-6 text-center'}>
            {embedded ? (
              <div className="bg-white rounded-2xl border border-shopSoft/60 p-4 shadow-sm flex items-center justify-between mb-5">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-shopCard mb-0.5">Attendance</p>
                  <h2 className="text-xl font-black text-[#111111]">{currentDate}</h2>
                  <p className="text-[13px] text-[#6B7280] font-medium mt-0.5">Select your name to punch</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-black text-shopCard">{currentTime}</p>
                </div>
              </div>
            ) : (
              <>
                <p className="text-[12px] font-black uppercase tracking-widest text-shopCard mb-1">Today</p>
                <h1 className="text-2xl font-black text-[#111111]">{currentDate}</h1>
                <p className="text-[13px] text-[#6B7280] mt-1 font-medium">Select your name to mark attendance</p>
              </>
            )}
          </div>

          {loading ? (
            <div className="flex justify-center py-16"><span className="h-10 w-10 animate-spin rounded-full border-4 border-shopSoft border-t-shopCard" /></div>
          ) : staff.length === 0 ? (
            <div className="text-center py-16"><p className="text-[#6B7280] font-bold">No staff found. Ask admin to add staff members.</p></div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {staff.map(s => (
                <button key={s.id} onClick={() => void selectStaff(s)}
                  className="bg-white rounded-2xl border border-shopSoft/60 p-4 text-left shadow-sm hover:border-shopCard/40 hover:shadow-md active:scale-95 transition-all">
                  <div className="h-12 w-12 rounded-xl bg-[#FFF0E6] flex items-center justify-center mb-3">
                    <span className="text-2xl font-black text-shopCard">{s.name.charAt(0).toUpperCase()}</span>
                  </div>
                  <p className="font-black text-[#111111] text-[15px] leading-tight">{s.name}</p>
                  <p className="text-[11px] text-[#9BAB9A] font-semibold mt-0.5">{s.role}</p>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* STEP: PUNCH */}
      {step === 'punch' && selectedStaff && (
        <div className="flex flex-col items-center">
          <button onClick={reset} className="self-start flex items-center gap-1 text-shopCard font-bold text-sm mb-6">
            <ChevronLeft size={18} /> Back
          </button>
          {loading ? (
            <div className="flex justify-center py-16"><span className="h-10 w-10 animate-spin rounded-full border-4 border-shopSoft border-t-shopCard" /></div>
          ) : (
            <div className="w-full max-w-sm mx-auto">
              <div className="bg-white rounded-2xl border border-shopSoft/60 p-6 shadow-sm mb-6 text-center">
                <div className="h-20 w-20 rounded-2xl bg-[#FFF0E6] flex items-center justify-center mx-auto mb-4">
                  <span className="text-4xl font-black text-shopCard">{selectedStaff.name.charAt(0).toUpperCase()}</span>
                </div>
                <h2 className="text-2xl font-black text-[#111111]">{selectedStaff.name}</h2>
                <p className="text-[#6B7280] font-semibold">{selectedStaff.role}</p>
                <p className="text-[12px] text-[#9BAB9A] mt-2">{currentDate}</p>
              </div>

              {todayRecord && (todayRecord.clock_in || todayRecord.clock_out) && (
                <div className="bg-white rounded-2xl border border-shopSoft/60 p-4 mb-5 space-y-2">
                  {todayRecord.clock_in && (
                    <div className="flex items-center gap-2">
                      <LogIn size={16} className="text-green-600 shrink-0" />
                      <span className="text-[13px] font-bold text-[#374151]">Clocked In</span>
                      <span className="ml-auto text-[13px] font-black text-green-700">{formatTime(todayRecord.clock_in)}</span>
                    </div>
                  )}
                  {todayRecord.clock_out && (
                    <div className="flex items-center gap-2">
                      <LogOut size={16} className="text-red-500 shrink-0" />
                      <span className="text-[13px] font-bold text-[#374151]">Clocked Out</span>
                      <span className="ml-auto text-[13px] font-black text-red-600">{formatTime(todayRecord.clock_out)}</span>
                    </div>
                  )}
                </div>
              )}

              {notice && !['punch_in','punch_out'].includes(notice) && (
                <p className="text-red-600 text-sm font-bold text-center mb-4">{notice}</p>
              )}

              {!todayRecord?.clock_in ? (
                <button onClick={() => void punchIn()} disabled={saving}
                  className="w-full bg-shopDeep border border-white/30 hover:bg-shopCard text-white rounded-2xl py-5 text-xl font-black shadow-lg shadow-black/20 active:scale-95 transition-all disabled:opacity-60 flex items-center justify-center gap-3">
                  <LogIn size={24} />{saving ? 'Recording...' : 'PUNCH IN'}
                </button>
              ) : !todayRecord?.clock_out ? (
                <div className="space-y-3">
                  <button onClick={() => void punchOut()} disabled={saving}
                    className="w-full bg-red-500 hover:bg-red-600 text-white rounded-2xl py-5 text-xl font-black shadow-lg shadow-red-500/30 active:scale-95 transition-all disabled:opacity-60 flex items-center justify-center gap-3">
                    <LogOut size={24} />{saving ? 'Recording...' : 'PUNCH OUT'}
                  </button>
                  <p className="text-center text-[12px] text-[#9BAB9A] font-semibold">You are currently clocked in</p>
                </div>
              ) : (
                <div className="bg-green-50 border border-green-200 rounded-2xl p-5 text-center">
                  <CheckCircle size={32} className="text-green-600 mx-auto mb-2" />
                  <p className="font-black text-green-800">Attendance complete for today!</p>
                  <p className="text-[12px] text-green-600 mt-1">In: {formatTime(todayRecord.clock_in)} · Out: {formatTime(todayRecord.clock_out)}</p>
                </div>
              )}

              <button onClick={reset} className="w-full mt-4 py-3 text-[#6B7280] font-bold text-sm hover:text-[#111111] transition-colors">
                Back to staff list
              </button>
            </div>
          )}
        </div>
      )}

      {/* STEP: DONE */}
      {step === 'done' && selectedStaff && (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className={`h-24 w-24 rounded-full flex items-center justify-center mx-auto mb-6 ${notice === 'punch_in' ? 'bg-green-100' : 'bg-orange-100'}`}>
            {notice === 'punch_in' ? <LogIn size={40} className="text-green-600" /> : <LogOut size={40} className="text-orange-600" />}
          </div>
          <h2 className="text-2xl font-black text-[#111111] mb-1">{notice === 'punch_in' ? 'Punched In!' : 'Punched Out!'}</h2>
          <p className="text-[#6B7280] font-semibold mb-1">{selectedStaff.name}</p>
          <p className="text-lg font-black text-shopCard mb-6">
            {notice === 'punch_in' ? formatTime(todayRecord?.clock_in ?? null) : formatTime(todayRecord?.clock_out ?? null)}
          </p>
          {todayRecord?.clock_in && todayRecord?.clock_out && (
            <div className="bg-white rounded-2xl border border-shopSoft/60 p-4 mb-6 w-full max-w-xs text-sm">
              <div className="flex justify-between font-bold">
                <span className="text-green-700">In: {formatTime(todayRecord.clock_in)}</span>
                <span className="text-red-600">Out: {formatTime(todayRecord.clock_out)}</span>
              </div>
            </div>
          )}
          {notice === 'punch_in' && !todayRecord?.clock_out && (
            <p className="text-[13px] text-[#9BAB9A] mb-6">Remember to punch out when you leave!</p>
          )}
          <button onClick={reset}
            className="bg-shopDeep border border-white/30 text-white px-8 py-3 rounded-xl font-black hover:bg-shopCard active:scale-95 transition-all">
            Done
          </button>
        </div>
      )}
    </div>
  )

  if (embedded) {
    return inner
  }

  return (
    <div className="min-h-screen bg-[#FFF8F3] flex flex-col">
      <div className="bg-shopCard px-5 py-4 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-3">
          <img src={BRAND_LOGO} alt="Logo" className="h-9 w-9 rounded-xl object-cover bg-white" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          <div>
            <p className="text-white font-black text-base leading-tight">{BRAND_EN}</p>
            <p className="text-white/70 text-[11px] font-bold">Staff Attendance</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-white font-black text-sm">{currentTime}</p>
          <p className="text-white/70 text-[10px]">{new Date().toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' })}</p>
        </div>
      </div>
      {inner}
      <div className="text-center py-3"><p className="text-[10px] text-[#9BAB9A]">Powered by {BRAND_EN} Billing System</p></div>
    </div>
  )
}
