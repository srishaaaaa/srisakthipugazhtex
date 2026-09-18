import React, { useCallback, useEffect, useState, useMemo, useRef, type FormEvent } from 'react'
import {
  BarChart2, Trash2, Edit2, List, ShoppingCart, LayoutDashboard,
  Box, Receipt, AlertCircle, Power, Download, TrendingUp,
  Package, Search, RefreshCw, ShieldCheck, ShieldOff, Trophy,
  MessageCircle, ChevronDown, Eye, FileText, Printer, X, Users, AlertTriangle, Tag, CheckCircle2, Repeat, Settings,
} from 'lucide-react'

// Custom Indian Rupee icon — replaces the generic dollar-sign icon
const RMIcon = ({ size = 16, className = '' }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-label="Indian Rupee"
  >
    <rect x="2" y="2" width="20" height="20" rx="4" />
    <text
      x="12"
      y="16"
      textAnchor="middle"
      fontSize="9"
      fontWeight="bold"
      stroke="none"
      fill="currentColor"
      fontFamily="Arial, sans-serif"
    >₹</text>
  </svg>
)
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { debounce } from '../lib/debounce'
import { useAuthStore, useProductStore, useAdminAuthStore, useSettingsStore } from '../store/store'
import { useBodyScrollLock } from '../components/ui/useBodyScrollLock'
import { formatCurrency, normalizeOrderMode, toNumber } from '../lib/retail'
import { normalizeStructuredOrderItem, formatInvoiceNo } from '../lib/retail'
import { formatPhoneDisplay } from '../lib/phone'
import { Invoice } from '../components/Invoice'
import LowStockAlarmModal from '../components/LowStockAlarmModal'
import Expenses from './Expenses'
import Attendance from './Attendance'
import StaffPunch from './StaffPunch'
import Inventory from './Inventory'
import StoreSettings from './StoreSettings'
import { printThermalReceipt } from '../lib/thermalPrint'
import { buildProfessionalWhatsAppMessage } from '../lib/whatsappMessage'
import { invoicePdfFile } from '../lib/invoicePdf'
import { BRAND_EN, BRAND_LOGO } from '../lib/brand'
// toWhatsAppUrl removed - using direct link building in handlers
import Pos from './Pos'
import AdvanceOrders from './AdvanceOrders'
import {
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  BarChart,
  Bar,
} from 'recharts'

type DashboardOrder = {
  id: string; invoice_no: string; customer_name: string; phone: string; address: string
  created_at: string; total: number; status: string; order_mode: string; order_type: string; user_id: string | null; items: unknown
  coupon_code: string; discount_amount: number; manual_discount_amount: number; delivery_charge: number
  total_gst: number; payment_mode: string; payment_method?: string; invoice_pdf_url: string; remarks?: string; reference_number?: string
}
type DashboardOrderItem = { order_id: string; product_name: string; category?: string; quantity: number; line_total: number; is_manual?: boolean | null }
type DashboardCoupon = {
  id: number
  code: string
  percentage: number
  is_active: boolean
  expiry_date: string | null
  usage_limit: number | null
  usage_count: number
  min_order_value: number
}
type TabKey = 'overview' | 'whatsapp' | 'pos_analytics' | 'billing' | 'advance_orders' | 'coupons' | 'users' | 'history' | 'expenses' | 'attendance' | 'inventory' | 'store_settings'
type PosAnalyticsTab = 'revenue' | 'today' | 'products' | 'categories' | 'coupons'
type ProfileUser = { id: string; email: string; name: string; mobile: string; role: string; created_at: string }

const normalizeStatus = (v: unknown) => String(v || '').trim().toLowerCase()
const normalizeOrderType = (v: unknown) => String(v || '').trim().toLowerCase() || 'pos_sale'
const isCompletedStatus = (v: unknown) => {
  const status = normalizeStatus(v)
  return status === 'completed' || status === 'paid'
}
const parseOrderItems = (items: unknown): Record<string, unknown>[] => {
  if (Array.isArray(items)) return items.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
  if (typeof items === 'string') { try { const p = JSON.parse(items); return Array.isArray(p) ? p : [] } catch { return [] } }
  return []
}

// When o.total is 0 (legacy orders saved with bug), compute it from the items JSON
const getOrderTotal = (order: { total: unknown; items: unknown; shipping?: unknown; delivery_charge?: unknown; total_gst?: unknown; discount_amount?: unknown; manual_discount_amount?: unknown }): number => {
  const stored = toNumber(order.total, 0)
  if (stored > 0) return stored
  const items = parseOrderItems(order.items)
  const subtotal = items.reduce((sum, item) => {
    const lineTotal = toNumber(item.line_total ?? item.lineTotal, 0)
    if (lineTotal > 0) return sum + lineTotal
    return sum + toNumber(item.base_price ?? item.basePrice ?? item.price, 0) * Math.max(1, toNumber(item.quantity, 1))
  }, 0)
  return Math.max(0, subtotal
    + toNumber(order.shipping ?? order.delivery_charge, 0)
    + toNumber(order.total_gst, 0)
    - toNumber(order.discount_amount, 0)
    - toNumber(order.manual_discount_amount, 0)
  )
}

const exportCSV = (orders: DashboardOrder[]) => {
  const header = ['Order Ref', 'Customer', 'Phone', 'Date', 'Total (₹)', 'Order Type', 'Status']
  const rows = orders.map(o => [
    o.order_type === 'online_request' ? o.id : o.invoice_no, o.customer_name, o.phone ? formatPhoneDisplay(o.phone) : '',
    new Date(o.created_at).toLocaleDateString('en-IN'),
    getOrderTotal(o).toFixed(2), o.order_type, o.status,
  ])
  const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `orders_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function Dashboard() {
  const { user } = useAuthStore()
  const { products, fetchProducts } = useProductStore()
  const location = useLocation()
  const navigate = useNavigate()
  const role = useAdminAuthStore(state => state.role)
  // Shop name/logo come from the saved Store Settings profile.
  const shopSettings = useSettingsStore(state => state.settings)
  const shopName = shopSettings?.name || BRAND_EN
  const shopLogo = shopSettings?.logoUrl || BRAND_LOGO
  const adminLoggedIn = useAdminAuthStore(state => state.isLoggedIn)
  const [tab, setTab] = useState<TabKey>(() => {
    if (location.pathname === '/whatsapp-center') return 'whatsapp'
    if (location.pathname === '/pos-analytics' && role === 'admin') return 'pos_analytics'
    if (location.pathname === '/advance-orders') return 'advance_orders'
    return 'billing'
  })
  const [posAnalyticsTab, setPosAnalyticsTab] = useState<PosAnalyticsTab>('revenue')
  const [orders, setOrders] = useState<DashboardOrder[]>([])
  const [orderItems, setOrderItems] = useState<DashboardOrderItem[]>([])
  const [coupons, setCoupons] = useState<DashboardCoupon[]>([])
  const [expensesList, setExpensesList] = useState<{ amount: number }[]>([])
  const [couponForm, setCouponForm] = useState({ code: '', percentage: 10, expiry_date: '', usage_limit: '', min_order_value: '' })
  const [couponSaveError, setCouponSaveError] = useState('')
  const [couponSaveSuccess, setCouponSaveSuccess] = useState('')
  const [editingCouponId, setEditingCouponId] = useState<number | null>(null)

  const [analyticsTab, setAnalyticsTab] = useState('revenue')

  const [invoicePreviewOrder, setInvoicePreviewOrder] = useState<DashboardOrder | null>(null)
  useBodyScrollLock(!!invoicePreviewOrder)
  const invoicePreviewRef = useRef<HTMLDivElement>(null)
  // A4 is 210x297mm — mirror that ratio as a *minimum* height so the
  // previewed invoice reads as a full page, like the live digital invoice.
  const [invoicePreviewMinHeight, setInvoicePreviewMinHeight] = useState<number>()
  useEffect(() => {
    const el = invoicePreviewRef.current
    if (!el) return
    const updateMinHeight = () => setInvoicePreviewMinHeight(el.offsetWidth * (297 / 210))
    updateMinHeight()
    const observer = new ResizeObserver(updateMinHeight)
    observer.observe(el)
    return () => observer.disconnect()
  }, [invoicePreviewOrder])

  // WA detail expansion
  const [waExpandedId, setWaExpandedId] = useState<string | null>(null)

  // Order history row expansion (remarks / ref no)
  const [historyExpandedId, setHistoryExpandedId] = useState<string | null>(null)

  // Search & date filter
  const [search, setSearch] = useState({ invoiceNo: '', phone: '', customerName: '', dateFrom: '', dateTo: '' })
  const [todayBillsSearch, setTodayBillsSearch] = useState('')
  const [productAnalyticsSearch, setProductAnalyticsSearch] = useState('')
  const [datePreset, setDatePreset] = useState<'today' | 'week' | 'month' | 'custom' | ''>('')
  const [searchResults, setSearchResults] = useState<DashboardOrder[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('dashboard-sidebar-collapsed') === '1'
    } catch {
      return false
    }
  })

  // Analytics global date filter
  const [analyticsDatePreset, setAnalyticsDatePreset] = useState<'all' | 'today' | 'week' | 'month' | 'year' | 'custom'>('all')
  const [analyticsDateFrom, setAnalyticsDateFrom] = useState('')
  const [analyticsDateTo, setAnalyticsDateTo] = useState('')

  // Order Management bill type filter
  const [billTypeFilter, setBillTypeFilter] = useState<'all' | 'offline' | 'online' | 'manual'>('all')

  // Users tab
  const [allUsers, setAllUsers] = useState<ProfileUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersError, setUsersError] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [roleUpdating, setRoleUpdating] = useState<string | null>(null)

  // Low-stock alarm — fires only on a genuine fresh login (the login store
  // action stamps a one-time sessionStorage flag), not on every reopen of
  // an already-authenticated tab/bookmark, since Zustand's persisted auth
  // state means Dashboard can mount with isLoggedIn already true without
  // the user having just typed credentials. The Inventory tab has its own
  // separate alarm that fires every time that tab is opened.
  const [isFreshLogin, setIsFreshLogin] = useState(false)
  useEffect(() => {
    try {
      if (sessionStorage.getItem('ssp_tex_fresh_login')) {
        sessionStorage.removeItem('ssp_tex_fresh_login')
        setIsFreshLogin(true)
      }
    } catch { /* ignore */ }
  }, [])
  const [ackedLowStockIds, setAckedLowStockIds] = useState<Set<string | number>>(new Set())
  const loginLowStockItems = products
    .filter(p => p.isActive && p.stockQuantity <= (p.lowStockAlert || 5))
    .map(p => ({ id: p.id, name: p.name, category: p.category, stock: p.stockQuantity, alertLimit: p.lowStockAlert || 5 }))
  const unackedLoginLowStockItems = isFreshLogin ? loginLowStockItems.filter(i => !ackedLowStockIds.has(i.id)) : []
  const acknowledgeLoginLowStockAlarm = () => {
    setAckedLowStockIds(prev => new Set([...prev, ...loginLowStockItems.map(i => i.id)]))
  }

  const isAdmin = adminLoggedIn && (role === 'admin' || role === 'staff')
  const l = (en: string, _ta?: string) => en

  const handleTabClick = (tabKey: TabKey) => {
    setTab(tabKey)
  }

  const deletedOrderIds = React.useRef<Set<string>>(new Set())

  const toDashboardOrder = (row: Record<string, unknown>): DashboardOrder => ({
    id: String(row.id || ''), invoice_no: String(row.invoice_no || ''),
    customer_name: String(row.customer_name || ''), phone: String(row.phone || ''),
    address: String(row.address || ''),
    created_at: String(row.created_at || ''), total: toNumber(row.total, 0),
    status: String(row.status || 'pending'),
    order_mode: normalizeOrderMode(row.order_mode),
    order_type: normalizeOrderType(row.order_type),
    user_id: typeof row.user_id === 'string' ? row.user_id : null,
    items: row.items,
    coupon_code: String(row.coupon_code || ''),
    discount_amount: toNumber(row.discount_amount, 0),
    manual_discount_amount: toNumber(row.manual_discount_amount, 0),
    delivery_charge: toNumber(row.delivery_charge, 0),
    total_gst: toNumber(row.total_gst ?? row.gst_amount, 0),
    payment_mode: String(row.payment_mode || row.payment_method || ''),
    invoice_pdf_url: String(row.invoice_pdf_url || ''),
    remarks: row.remarks ? String(row.remarks) : undefined,
    reference_number: row.reference_number ? String(row.reference_number) : undefined,
  })

  // Analytics (date-aware)
  const lowStockProducts = products.filter(p => p.isActive && p.stockQuantity <= (p.lowStockAlert || 5))
  const analytics = useMemo(() => {
    // Apply global date filter
    let dated = orders
    if (analyticsDateFrom) dated = dated.filter(o => o.created_at >= `${analyticsDateFrom}T00:00:00`)
    if (analyticsDateTo)   dated = dated.filter(o => o.created_at <= `${analyticsDateTo}T23:59:59`)

    // Classify
    const nonCancelled = dated.filter(o => normalizeStatus(o.status) !== 'cancelled')
    const completedOrders = nonCancelled.filter(o => isCompletedStatus(o.status))
    const pendingOrders   = nonCancelled.filter(o => normalizeStatus(o.status) === 'pending')

    // WhatsApp = online_request type (all statuses, no revenue)
    const waOrders = dated.filter(o => normalizeOrderType(o.order_type) === 'online_request')

    // Billable = completed and NOT online_request
    const billableCompleted = completedOrders.filter(o => normalizeOrderType(o.order_type) !== 'online_request')
    // The trend charts are fixed calendar views. The period selector filters
    // KPIs/tables, but must not change the year/week bars underneath them.
    const allBillableCompleted = orders
      .filter(o => normalizeStatus(o.status) !== 'cancelled')
      .filter(o => isCompletedStatus(o.status))
      .filter(o => normalizeOrderType(o.order_type) !== 'online_request')
    // Channel is determined by order_mode. Older orders can use a different
    // order_type, so requiring exactly `pos_sale` hides valid online bills.
    const offlinePOS  = billableCompleted.filter(o => normalizeOrderMode(o.order_mode) === 'offline' && normalizeOrderType(o.order_type) !== 'manual_sale')
    const onlinePOS   = billableCompleted.filter(o => normalizeOrderMode(o.order_mode) === 'online')
    const manualSales = billableCompleted.filter(o => normalizeOrderType(o.order_type) === 'manual_sale')

    // Revenue (WhatsApp never included)
    const completedRevenue   = billableCompleted.reduce((s, o) => s + getOrderTotal(o), 0)
    const averageRevenuePerBill = billableCompleted.length > 0 ? completedRevenue / billableCompleted.length : 0
    const posRevenue         = offlinePOS.reduce((s, o) => s + getOrderTotal(o), 0)
    const onlinePosRevenue   = onlinePOS.reduce((s, o) => s + getOrderTotal(o), 0)
    const manualRevenue      = manualSales.reduce((s, o) => s + getOrderTotal(o), 0)

    const toLocalDateKey = (value: string | Date) => {
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }
    const toLocalMonthKey = (value: string | Date) => toLocalDateKey(value).slice(0, 7)

    const todayKey  = toLocalDateKey(new Date())
    const monthKey  = todayKey.slice(0, 7)
    const todaySales   = orders.filter(o => isCompletedStatus(o.status) && o.order_type !== 'whatsapp_request' && toLocalDateKey(o.created_at) === todayKey).reduce((s, o) => s + getOrderTotal(o), 0)

    // Today-specific analytics (for TODAY'S SALES tab)
    const todayOrders = billableCompleted.filter(o => toLocalDateKey(o.created_at) === todayKey)
    const todayCompletedOrdersCount = todayOrders.length
    const todayItemsSold = todayOrders.reduce((s, o) => {
      const items = parseOrderItems(o.items)
      return s + items.reduce((sum, item) => sum + toNumber(item.quantity ?? item.qty, 0), 0)
    }, 0)
    const todayAvgOrderValue = todayCompletedOrdersCount > 0 ? todaySales / todayCompletedOrdersCount : 0

    // Hourly trend for today
    const hourlyMap = new Map<string, number>()
    todayOrders.forEach(o => {
      const hour = String(new Date(o.created_at).getHours()).padStart(2, '0')
      hourlyMap.set(hour, (hourlyMap.get(hour) || 0) + getOrderTotal(o))
    })
    const todayHourlyTrend = Array.from({ length: 24 }, (_, i) => {
      const h = String(i).padStart(2, '0')
      // Use 12-hour format
      const ampm = i < 12 ? 'AM' : 'PM'
      const h12 = i === 0 ? 12 : i > 12 ? i - 12 : i
      return { hour: `${h12} ${ampm}`, key: h, revenue: hourlyMap.get(h) || 0 }
    })

    // Today's top products
    const todayProductMap = new Map<string, { name: string; qty: number; revenue: number }>()
    todayOrders.forEach(o => {
      parseOrderItems(o.items).forEach(item => {
        const name = String(item.product_name || item.name || 'Product').trim()
        const qty = toNumber(item.quantity ?? item.qty, 0)
        const rev = toNumber(item.line_total ?? item.lineTotal, 0)
        const p = todayProductMap.get(name) || { name, qty: 0, revenue: 0 }
        p.qty += qty; p.revenue += rev
        todayProductMap.set(name, p)
      })
    })
    const todayTopProducts = Array.from(todayProductMap.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 5)
    const todayBills = todayOrders.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 10)

    // Today's channel breakdown
    const todayOffline = todayOrders.filter(o => normalizeOrderType(o.order_type) === 'pos_sale' && normalizeOrderMode(o.order_mode) !== 'online')
    const todayOnline = todayOrders.filter(o => normalizeOrderType(o.order_type) === 'pos_sale' && normalizeOrderMode(o.order_mode) === 'online')
    const todayManual = todayOrders.filter(o => normalizeOrderType(o.order_type) === 'manual_sale')
    const todayOfflineRevenue = todayOffline.reduce((s, o) => s + getOrderTotal(o), 0)
    const todayOnlineRevenue = todayOnline.reduce((s, o) => s + getOrderTotal(o), 0)
    const todayManualRevenue = todayManual.reduce((s, o) => s + getOrderTotal(o), 0)

    // Product hourly trend (products sold per hour today)
    const productHourlyMap = new Map<string, number>()
    todayOrders.forEach(o => {
      const hour = String(new Date(o.created_at).getHours()).padStart(2, '0')
      const totalQty = parseOrderItems(o.items).reduce((s, item) => s + toNumber(item.quantity ?? item.qty, 0), 0)
      productHourlyMap.set(hour, (productHourlyMap.get(hour) || 0) + totalQty)
    })
    const todayProductHourlyTrend = Array.from({ length: 24 }, (_, i) => {
      const h = String(i).padStart(2, '0')
      const ampm = i < 12 ? 'AM' : 'PM'
      const h12 = i === 0 ? 12 : i > 12 ? i - 12 : i
      return { hour: `${h12} ${ampm}`, key: h, qty: productHourlyMap.get(h) || 0 }
    })

    const monthlyRevenue = billableCompleted.filter(o => toLocalMonthKey(o.created_at) === monthKey).reduce((s, o) => s + getOrderTotal(o), 0)

    // Item-level analytics
    const completedIds = new Set(billableCompleted.map(o => o.id))
    const completedItems = orderItems.length > 0
      ? orderItems.filter(item => completedIds.has(item.order_id))
      : completedOrders.flatMap(order => parseOrderItems(order.items).map(row => ({
          order_id: order.id,
          product_name: String((row as Record<string,unknown>).product_name || (row as Record<string,unknown>).name || 'Product'),
          category: String((row as Record<string,unknown>).category || ''),
          quantity: toNumber((row as Record<string,unknown>).quantity ?? (row as Record<string,unknown>).qty, 0),
          line_total: toNumber((row as Record<string,unknown>).line_total ?? (row as Record<string,unknown>).lineTotal, 0),
          is_manual: (row as Record<string,unknown>).is_manual === true || (row as Record<string,unknown>).source === 'manual',
        })))

    const productMap    = new Map<string, { name: string; variant: string; qty: number; revenue: number; billCount: number }>()
    const productOrders = new Map<string, Set<string>>()
    const categoryMap   = new Map<string, { name: string; qty: number; revenue: number }>()
    const prodCatLookup = new Map(products.map(p => [String(p.name || '').trim().toLowerCase(), p.category || 'Uncategorized']))

    let totalProductsSold = 0
    let totalManualRevenue = 0

    completedItems.forEach(({ product_name, category, quantity, line_total, order_id, is_manual }) => {
      const qty = toNumber(quantity, 0)
      const rev = toNumber(line_total, 0)
      totalProductsSold += qty

      const rawKey  = String(product_name || 'Product').trim() || 'Product'
      const dashIdx = rawKey.indexOf(' - ')
      const mainName   = dashIdx > 0 ? rawKey.slice(0, dashIdx) : rawKey
      const variantName = dashIdx > 0 ? rawKey.slice(dashIdx + 3) : ''

      const pc = productMap.get(rawKey) || { name: mainName, variant: variantName, qty: 0, revenue: 0, billCount: 0 }
      pc.qty += qty; pc.revenue += rev; productMap.set(rawKey, pc)

      if (!productOrders.has(rawKey)) productOrders.set(rawKey, new Set())
      productOrders.get(rawKey)!.add(order_id)

      const catName = category || prodCatLookup.get(mainName.toLowerCase()) || 'Uncategorized'
      const cc = categoryMap.get(catName) || { name: catName, qty: 0, revenue: 0 }
      cc.qty += qty; cc.revenue += rev; categoryMap.set(catName, cc)

      if (is_manual) totalManualRevenue += rev
    })

    for (const [key, orderSet] of productOrders) {
      const p = productMap.get(key); if (p) { p.billCount = orderSet.size; productMap.set(key, p) }
    }

    const topProducts   = Array.from(productMap.values()).sort((a, b) => b.qty - a.qty)
    const topCategories = Array.from(categoryMap.values()).sort((a, b) => b.revenue - a.revenue)
    const bestProduct   = topProducts[0]?.name || 'No sales yet'
    const bestCategory  = topCategories[0]?.name || 'No sales yet'

    // Average items per bill
    const avgItemsPerBill = billableCompleted.length > 0
      ? totalProductsSold / billableCompleted.length : 0
    const averageProductRevenue = totalProductsSold > 0
      ? completedRevenue / totalProductsSold : 0

    // Category distribution for chart
    const categoryDist = Array.from(categoryMap.entries()).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 8)
      .map(([name, data]) => ({ name, value: data.revenue }))

    // Trend charts
    const chartYear = new Date().getFullYear()
    const monthlyRevenueMap = new Map<string, number>()
    allBillableCompleted.forEach(o => {
      const k = toLocalMonthKey(o.created_at)
      monthlyRevenueMap.set(k, (monthlyRevenueMap.get(k) || 0) + getOrderTotal(o))
    })
    const monthlyTrend = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(chartYear, i, 1)
      const k = toLocalMonthKey(d)
      return { key: k, month: d.toLocaleDateString('en-MY', { month: 'short' }), revenue: monthlyRevenueMap.get(k) || 0 }
    })

    const weeklyRevenueMap = new Map<string, number>()
    allBillableCompleted.forEach(o => {
      const k = toLocalDateKey(o.created_at)
      weeklyRevenueMap.set(k, (weeklyRevenueMap.get(k) || 0) + getOrderTotal(o))
    })

    const currentDayOfWeek = new Date().getDay() || 7 // 1: Mon, ..., 7: Sun
    const mondayDate = new Date()
    mondayDate.setDate(mondayDate.getDate() - currentDayOfWeek + 1)

    const weeklySales = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mondayDate)
      d.setDate(d.getDate() + i)
      const k = toLocalDateKey(d)
      // Force short weekday names in English to match Mon, Tue, Wed, Thu, Fri, Sat, Sun exactly
      const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d)
      return { day: dayName, date: k, revenue: weeklyRevenueMap.get(k) || 0 }
    })

    const currentMonthDate = new Date()
    const daysInCurrentMonth = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth() + 1, 0).getDate()
    const monthDailySales = Array.from({ length: daysInCurrentMonth }, (_, i) => {
      const d = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth(), i + 1)
      const k = toLocalDateKey(d)
      return { day: `${i + 1}`, date: `${i + 1}/${currentMonthDate.getMonth() + 1}`, label: `Day ${i + 1}`, revenue: weeklyRevenueMap.get(k) || 0 }
    })

    const statusDistribution = [
      { name: 'WA Requests', value: waOrders.length, color: '#3b82f6' },
      { name: 'POS Pending', value: pendingOrders.filter(o => normalizeOrderType(o.order_type) !== 'online_request').length, color: '#f59e0b' },
      { name: 'Completed',   value: billableCompleted.length, color: '#10b981' },
    ]
    const channelDistribution = [
      { name: 'Offline Bills', value: posRevenue, color: '#f97316' },
      { name: 'Online Bills',  value: onlinePosRevenue, color: '#3b82f6' },
      { name: 'Manual Sales',  value: manualRevenue || totalManualRevenue, color: '#8b5cf6' },
    ]

    const couponMap = new Map<string, { code: string; usage: number; discounts: number }>()
    billableCompleted.forEach(order => {
      const code = String((order as Record<string,unknown>).coupon_code || '').trim(); if (!code) return
      const u = couponMap.get(code) || { code, usage: 0, discounts: 0 }
      u.usage += 1; u.discounts += toNumber((order as Record<string,unknown>).discount_amount, 0)
      couponMap.set(code, u)
    })
    const topCoupons = Array.from(couponMap.values()).sort((a, b) => b.usage - a.usage)
    const totalCouponDiscounts = topCoupons.reduce((s, c) => s + c.discounts, 0)
    const totalCouponOrders = topCoupons.reduce((s, c) => s + c.usage, 0)
    const couponUsageRate = billableCompleted.length > 0
      ? (totalCouponOrders / billableCompleted.length) * 100 : 0

    // Coupon daily trend (last 7 days)
    const couponDailyMap = new Map<string, { orders: number; discounts: number }>()
    billableCompleted.forEach(order => {
      const code = String((order as Record<string,unknown>).coupon_code || '').trim()
      if (!code) return
      const k = toLocalDateKey(order.created_at)
      const d = couponDailyMap.get(k) || { orders: 0, discounts: 0 }
      d.orders += 1
      d.discounts += toNumber((order as Record<string,unknown>).discount_amount, 0)
      couponDailyMap.set(k, d)
    })
    const couponDailyTrend = Array.from({ length: 7 }, (_, i) => {
      const d = new Date()
      d.setDate(d.getDate() - (6 - i))
      const k = toLocalDateKey(d)
      const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d)
      const data = couponDailyMap.get(k) || { orders: 0, discounts: 0 }
      return { day: dayName, date: k, orders: data.orders, discounts: data.discounts }
    })

    // WhatsApp analytics (zero revenue - status changes never affect revenue)
    const waRequests  = waOrders.length
    const waPending   = waOrders.filter(o => normalizeStatus(o.status) === 'pending').length
    const waContacted = waOrders.filter(o => normalizeStatus(o.status) === 'contacted').length
    const waCompleted = waOrders.filter(o => isCompletedStatus(o.status)).length

    const waProductMap = new Map<string, number>()
    waOrders.forEach(order => {
      parseOrderItems(order.items).forEach(item => {
        const n = String((item as Record<string,unknown>).name || (item as Record<string,unknown>).product_name || '').trim()
        if (n) waProductMap.set(n, (waProductMap.get(n) || 0) + 1)
      })
    })
    const topWAProducts = Array.from(waProductMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, count]) => ({ name, count }))

    const waCategoryMap = new Map<string, number>()
    waOrders.forEach(order => {
      parseOrderItems(order.items).forEach(item => {
        const n = String((item as Record<string,unknown>).name || (item as Record<string,unknown>).product_name || '').trim()
        if (n) {
          const mainName = n.includes(' - ') ? n.split(' - ')[0] : n
          const catName = prodCatLookup.get(mainName.toLowerCase()) || 'Uncategorized'
          waCategoryMap.set(catName, (waCategoryMap.get(catName) || 0) + 1)
        }
      })
    })
    const topWACategories = Array.from(waCategoryMap.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, count]) => ({ name, count }))

    return {
      totalCompletedRevenue: completedRevenue,
      averageRevenuePerBill,
      todaySales,
      todayCompletedOrdersCount,
      todayItemsSold,
      todayAvgOrderValue,
      todayHourlyTrend,
      todayTopProducts,
      todayBills,
      todayOfflineRevenue,
      todayOnlineRevenue,
      todayManualRevenue,
      todayProductHourlyTrend,
      avgItemsPerBill,
      averageProductRevenue,
      categoryDist,
      totalCouponDiscounts,
      totalCouponOrders,
      couponUsageRate,
      couponDailyTrend,
      pendingOrders: pendingOrders.length,
      onlineRequests: waRequests,
      onlineRequestOrders: waOrders,
      completedOrders: billableCompleted.length,
      posRevenue,
      onlinePosRevenue,
      // Keep the bill count separate from revenue so the TOTAL ONLINE BILLS
      // card stays visible and always reflects the current completed orders.
      onlineBillCount: onlinePOS.length,
      monthDailySales,
      offlineOrderCount: offlinePOS.length,
      manualRevenue: manualRevenue || totalManualRevenue,
      monthlyRevenue,
      totalProductsSold,
      bestCategory,
      bestProduct,
      monthlyTrend,
      chartYear,
      channelDistribution,
      statusDistribution,
      topCoupons,
      topCategories,
      weeklySales,
      topProducts,
      waRequests,
      waPending,
      waContacted,
      waCompleted,
      topWAProducts,
      topWACategories,
      // Revenue split by item_type stored in each bill's items array
      productRevenue: (() => {
        let total = 0
        billableCompleted.forEach(order => {
          const items = parseOrderItems(order.items)
          items.forEach((item: Record<string, unknown>) => {
            if ((item.item_type || 'product') === 'product') {
              total += toNumber(item.line_total, 0)
            }
          })
        })
        return total
      })(),
      serviceRevenue: (() => {
        let total = 0
        billableCompleted.forEach(order => {
          const items = parseOrderItems(order.items)
          items.forEach((item: Record<string, unknown>) => {
            if (item.item_type === 'service') {
              total += toNumber(item.line_total, 0)
            }
          })
        })
        return total
      })(),
      totalExpenses: expensesList.reduce((s, e) => s + toNumber(e.amount, 0), 0),
      netProfit: completedRevenue - expensesList.reduce((s, e) => s + toNumber(e.amount, 0), 0),
    }
  }, [orders, orderItems, products, analyticsDateFrom, analyticsDateTo, expensesList])

  // Bill-type filtered results for Order Management table (client-side, instant)
  const filteredSearchResults = useMemo(() => {
    if (billTypeFilter === 'all') return searchResults
    return searchResults.filter(o => {
      const type = normalizeOrderType(o.order_type)
      const mode = normalizeOrderMode(o.order_mode)
      if (billTypeFilter === 'manual')  return type === 'manual_sale'
      if (billTypeFilter === 'offline') return type === 'pos_sale' && mode !== 'online'
      if (billTypeFilter === 'online')  return type === 'pos_sale' && mode === 'online'
      return true
    })
  }, [searchResults, billTypeFilter])

  // Load dashboard data
  const loadData = useCallback(async () => {
    if (!isSupabaseConfigured) return
    try {
      const productsPromise = fetchProducts(true)
      const [cRes, oRes, couponRes, eRes] = await Promise.all([
        supabase.from('categories').select('id, name_en, name_ta, is_active, sort_order').order('sort_order'),
        supabase.from('orders')
          .select('id, invoice_no, customer_name, phone, address, created_at, total, status, order_mode, order_type, user_id, items, coupon_code, discount_amount, manual_discount_amount, delivery_charge, total_gst, gst_amount, payment_mode, payment_method, invoice_pdf_url, remarks, reference_number')
          .order('created_at', { ascending: false })
          .limit(1000),
        supabase.from('coupons')
          .select('id, code, percentage, is_active, expiry_date, usage_limit, usage_count, min_order_value')
          .order('created_at', { ascending: false }),
        (async () => {
          const res = await supabase.from('expenses').select('amount')
          if (res.error) return { data: [] as { amount: number }[], error: null }
          return res
        })()
      ])
      if (cRes.error) throw cRes.error
      if (oRes.error) throw oRes.error
      const mappedOrders = (oRes.data || []).map((r: Record<string, unknown>) => toDashboardOrder(r))
      setOrders(mappedOrders)
      setSearchResults(mappedOrders.filter((o: DashboardOrder) => normalizeOrderType(o.order_type) !== 'online_request').slice(0, 100))
      setCoupons((couponRes.data || []) as DashboardCoupon[])
      setExpensesList((eRes.data || []) as { amount: number }[])

      const orderIds = mappedOrders.map((o: DashboardOrder) => o.id).filter(Boolean)
      if (orderIds.length > 0) {
        let oi: unknown[] | null = null
        let orderItemsError: unknown = null
        const orderItemsResult = await supabase
          .from('order_items').select('order_id,product_name,category,quantity,line_total,is_manual')
          .in('order_id', orderIds)
        oi = orderItemsResult.data
        orderItemsError = orderItemsResult.error

        if (orderItemsError) {
          const fallbackItemsResult = await supabase
            .from('order_items').select('order_id,product_name,quantity,line_total')
            .in('order_id', orderIds)
          oi = fallbackItemsResult.data
        }

        setOrderItems((oi || []).map(r => ({
          order_id: String((r as Record<string,unknown>).order_id || ''),
          product_name: String((r as Record<string,unknown>).product_name || 'Product'),
          category: String((r as Record<string,unknown>).category || ''),
          quantity: toNumber((r as Record<string,unknown>).quantity, 0),
          line_total: toNumber((r as Record<string,unknown>).line_total, 0),
          is_manual: Boolean((r as Record<string,unknown>).is_manual),
        })))
      }

      await productsPromise
    } catch (err) { console.error('Dashboard load error', err) }
  }, [fetchProducts])

  const loadUsers = useCallback(async () => {
    if (!isSupabaseConfigured) return
    setUsersLoading(true); setUsersError('')
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, name, mobile, role, created_at')
      .order('created_at', { ascending: false })
    if (error) { setUsersError(error.message) }
    else { setAllUsers((data || []) as ProfileUser[]) }
    setUsersLoading(false)
  }, [])

  const loadCoupons = useCallback(async () => {
    if (!isSupabaseConfigured) return
    const { data } = await supabase
      .from('coupons')
      .select('id, code, percentage, is_active, expiry_date, usage_limit, usage_count, min_order_value')
      .order('created_at', { ascending: false })
    setCoupons((data || []) as DashboardCoupon[])
  }, [])

  const toggleUserRole = async (u: ProfileUser) => {
    const newRole = u.role === 'admin' ? 'customer' : 'admin'
    setRoleUpdating(u.id)
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', u.id)
    if (!error) {
      setAllUsers(prev => prev.map(p => p.id === u.id ? { ...p, role: newRole } : p))
    }
    setRoleUpdating(null)
  }

  const updateOrderStatus = async (orderId: string, newStatus: string) => {
    await supabase.from('orders').update({ status: newStatus }).eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: newStatus } : o))
    setSearchResults(prev => prev.map(o => o.id === orderId ? { ...o, status: newStatus } : o))
  }

  const deleteOrder = async (orderId: string, invoiceNo: string) => {
    if (role === 'staff') {
      const pwd = window.prompt(`Enter admin password to delete order ${invoiceNo}:`)
      if (pwd !== '192267') {
        alert('Incorrect password. Deletion cancelled.')
        return
      }
    } else {
      if (!window.confirm(`Are you sure you want to completely delete order ${invoiceNo}? This cannot be undone.`)) return
    }
    // Clear FK reference in advance_orders first (if this order was created from an advance order)
    await supabase.from('advance_orders').update({ completed_order_id: null }).eq('completed_order_id', orderId)
    const { error } = await supabase.from('orders').delete().eq('id', orderId)
    if (error) {
      alert(`Error deleting order: ${error.message}`)
      return
    }
    // Track deleted ID so re-searches don't bring it back
    deletedOrderIds.current.add(orderId)
    setOrders(prev => prev.filter(o => o.id !== orderId))
    setSearchResults(prev => prev.filter(o => o.id !== orderId))
  }

  const getOrderWhatsAppPreview = (order: DashboardOrder) => {
    const rawItems = parseOrderItems(order.items)
    const fallbackItems = orderItems
      .filter(item => item.order_id === order.id)
      .map(item => ({ name: item.product_name, quantity: item.quantity, line_total: item.line_total }))
    const items = (rawItems.length ? rawItems : fallbackItems).map(normalizeStructuredOrderItem)
    if (!items.length) return null

    const subtotal = items.reduce((sum, item) => sum + toNumber(item.line_total, 0), 0)
    const message = buildProfessionalWhatsAppMessage({
      customerName: order.customer_name,
      phone: order.phone,
      invoiceNumber: order.invoice_no || order.id,
      invoiceDate: order.created_at,
      items: items.map(item => ({
        name: item.name,
        qty: item.quantity,
        unit: item.unit,
        unitType: item.unit_type,
        rate: item.base_price,
        lineTotal: item.line_total,
      })),
      subtotal,
      couponDiscount: order.discount_amount,
      shipping: order.delivery_charge,
      total: order.total,
    })
    return { items, subtotal, message, fileName: `Invoice-${order.invoice_no || order.id}.pdf` }
  }


  const handlePrintReceipt = (order: DashboardOrder) => {
    const preview = getOrderWhatsAppPreview(order)
    if (!preview) { alert('This order has no invoice details available.'); return }
    const subtotal = order.total - (order.delivery_charge || 0) + (order.discount_amount || 0)

    printThermalReceipt({
      invoiceNo: order.invoice_no || order.id,
      date: order.created_at,
      customerName: order.customer_name,
      phone: order.phone,
      items: (preview.items as Array<{
        name?: string
        product_name?: string
        qty?: number
        quantity?: number
        unit?: string
        price?: number
        base_price?: number
        line_total?: number
      }>).map((item) => ({
        name: item.name || item.product_name || '',
        qty: item.qty || item.quantity || 0,
        unit: item.unit || '',
        price: item.price || item.base_price || 0,
        line_total: item.line_total || 0
      })),
      subtotal,
      shipping: order.delivery_charge || 0,
      couponDiscount: order.discount_amount || 0,
      totalGst: order.total_gst || 0,
      total: order.total
    })
  }

  const openOrderInvoice = async (order: DashboardOrder, mode: 'view' | 'download' | 'print') => {
    if (mode === 'view') {
      setInvoicePreviewOrder(order)
      return
    }

    // Always regenerate from current order data instead of reusing
    // order.invoice_pdf_url — that file is a one-time snapshot saved at
    // sale time, so it keeps whatever invoice design existed back then
    // instead of picking up later layout fixes.
    const preview = getOrderWhatsAppPreview(order)
    if (!preview) { alert('This order has no invoice details available.'); return }
    const file = invoicePdfFile({
      invoiceNo: order.invoice_no || order.id,
      date: order.created_at,
      customerName: order.customer_name,
      phone: order.phone,
      address: order.address,
      items: preview.items as unknown as Array<Record<string, unknown>>,
      subtotal: preview.subtotal,
      shipping: order.delivery_charge,
      discountAmount: order.discount_amount,
      manualDiscountAmount: order.manual_discount_amount,
      gstAmount: order.total_gst,
      paymentMode: order.payment_mode,
      total: order.total,
    })
    const url = URL.createObjectURL(file)
    if (mode === 'download') {
      const link = document.createElement('a'); link.href = url; link.download = file.name; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return
    }
    const opened = window.open(url, '_blank', 'noopener,noreferrer')
    if (mode === 'print') opened?.addEventListener('load', () => opened.print())
  }

  const generateCouponCode = () => {
    const prefixes = ['SAVE', 'TASTY', 'FEAST', 'SHOP', 'SPECIAL', 'FRESH', 'NEW']
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)]
    const suffix = Math.floor(Math.random() * 90 + 10)
    setCouponForm(f => ({ ...f, code: `${prefix}${suffix}` }))
    setCouponSaveError('')
    setCouponSaveSuccess('')
  }

  const saveCoupon = async (e: FormEvent) => {
    e.preventDefault()
    setCouponSaveError('')
    setCouponSaveSuccess('')
    if (!couponForm.code.trim()) { setCouponSaveError('Coupon code is required'); return }
    if (!(toNumber(couponForm.percentage, 0) > 0 && toNumber(couponForm.percentage, 0) <= 100)) {
      setCouponSaveError('Discount must be between 1% and 100%'); return
    }
    const code = couponForm.code.trim().toUpperCase()
    const payload = {
      code,
      percentage: toNumber(couponForm.percentage, 0),
      is_active: true,
      expiry_date: couponForm.expiry_date || null,
      usage_limit: couponForm.usage_limit ? toNumber(couponForm.usage_limit, 0) : null,
      min_order_value: toNumber(couponForm.min_order_value, 0),
    }
    let error: unknown = null
    if (editingCouponId !== null) {
      // Update existing - don't change code (it's the PK equivalent)
      const res = await supabase.from('coupons').update({ ...payload }).eq('id', editingCouponId)
      error = res.error
    } else {
      // Insert new coupon - UNIQUE constraint on code catches duplicates
      const res = await supabase.from('coupons').insert(payload)
      error = res.error
    }
    if (error) {
      const msg = (error as { message?: string }).message || 'Failed to save coupon'
      if (msg.toLowerCase().includes('row-level security')) {
        setCouponSaveError("Coupon save was blocked by Supabase RLS. Confirm your user has the admin role and apply the required Supabase migrations.")
      } else {
        setCouponSaveError(msg.includes('unique') || msg.includes('duplicate') ? `Coupon code "${code}" already exists` : msg)
      }
    } else {
      setCouponForm({ code: '', percentage: 10, expiry_date: '', usage_limit: '', min_order_value: '' })
      setEditingCouponId(null)
      setCouponSaveSuccess(editingCouponId !== null ? 'Coupon updated!' : 'Coupon created!')
      await loadCoupons()
    }
  }

  const startEditCoupon = (coupon: DashboardCoupon) => {
    setEditingCouponId(coupon.id)
    setCouponForm({
      code: coupon.code,
      percentage: coupon.percentage,
      expiry_date: coupon.expiry_date ? coupon.expiry_date.slice(0, 10) : '',
      usage_limit: coupon.usage_limit !== null ? String(coupon.usage_limit) : '',
      min_order_value: coupon.min_order_value ? String(coupon.min_order_value) : '',
    })
    setCouponSaveError('')
    setCouponSaveSuccess('')
  }

  const cancelEditCoupon = () => {
    setEditingCouponId(null)
    setCouponForm({ code: '', percentage: 10, expiry_date: '', usage_limit: '', min_order_value: '' })
    setCouponSaveError('')
    setCouponSaveSuccess('')
  }

  const deleteCoupon = async (coupon: DashboardCoupon) => {
    if (!window.confirm(`Delete coupon "${coupon.code}"? This cannot be undone.`)) return
    await supabase.from('coupons').delete().eq('id', coupon.id)
    await loadCoupons()
  }

  const toggleCoupon = async (coupon: DashboardCoupon) => {
    await supabase.from('coupons').update({ is_active: !coupon.is_active }).eq('id', coupon.id)
    await loadCoupons()
  }

  // Keep a stable ref to the debounced loader so realtime events don't
  // trigger a full data reload more than once every 4 seconds.
  const debouncedLoadRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    debouncedLoadRef.current = debounce(() => void loadData(), 350)
  }, [loadData])

  useEffect(() => {
    if (!isAdmin) return
    void loadData()
    if (!isSupabaseConfigured) return
    const handleChange = () => debouncedLoadRef.current?.()
    const ch = supabase.channel('dashboard-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, handleChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, handleChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, handleChange)
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [isAdmin, loadData])

  useEffect(() => {
    if (tab === 'users') void loadUsers()
    if (tab === 'coupons') void loadCoupons()
    if (tab === 'history') void runSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSearch is redefined every render; only re-fetch when the tab itself changes to 'history'
  }, [tab, loadUsers, loadCoupons])

  const applyAnalyticsPreset = (preset: 'all' | 'today' | 'week' | 'month' | 'year' | 'custom') => {
    setAnalyticsDatePreset(preset)
    if (preset === 'all')    { setAnalyticsDateFrom(''); setAnalyticsDateTo(''); return }
    if (preset === 'custom') return
    const today = new Date()
    const todayStr = today.toISOString().slice(0, 10)
    if (preset === 'today') {
      setAnalyticsDateFrom(todayStr); setAnalyticsDateTo(todayStr)
    } else if (preset === 'week') {
      const d = new Date(today); d.setDate(today.getDate() - 6)
      setAnalyticsDateFrom(d.toISOString().slice(0, 10)); setAnalyticsDateTo(todayStr)
    } else if (preset === 'month') {
      setAnalyticsDateFrom(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`)
      setAnalyticsDateTo(todayStr)
    } else if (preset === 'year') {
      setAnalyticsDateFrom(`${today.getFullYear()}-01-01`); setAnalyticsDateTo(todayStr)
    }
  }

  const applyDatePreset = (preset: 'today' | 'week' | 'month' | 'custom') => {
    setDatePreset(preset)
    if (preset === 'custom') { setSearch(s => ({ ...s, dateFrom: '', dateTo: '' })); return }
    const today = new Date()
    const todayStr = today.toISOString().slice(0, 10)
    let newFrom = ''
    const newTo = todayStr
    if (preset === 'today') {
      newFrom = todayStr
    } else if (preset === 'week') {
      const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 6)
      newFrom = weekAgo.toISOString().slice(0, 10)
    } else if (preset === 'month') {
      newFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`
    }
    setSearch(s => ({ ...s, dateFrom: newFrom, dateTo: newTo }))
    // Auto-run search immediately with the new dates
    setTimeout(() => void runSearch(undefined, newFrom, newTo), 0)
  }

  // Order search - POS bills only (online_request excluded)
  const runSearch = async (e?: FormEvent, dateFromOverride?: string, dateToOverride?: string, billTypeOverride?: string) => {
    e?.preventDefault()
    setSearchLoading(true)
    try {
      const invInput = search.invoiceNo.trim()
      const phoneInput = search.phone.trim()
      const custInput = search.customerName.trim()
      const hasQuery = Boolean(invInput || phoneInput || custInput)

      let q = supabase.from('orders')
        .select('id, invoice_no, customer_name, phone, address, created_at, total, status, order_mode, order_type, items, coupon_code, discount_amount, manual_discount_amount, delivery_charge, total_gst, gst_amount, payment_mode, payment_method, invoice_pdf_url, remarks, reference_number')
        .neq('order_type', 'online_request')
        .order('created_at', { ascending: false })
        .limit(hasQuery ? 1000 : 500)

      if (invInput) {
        const digitsOnly = invInput.replace(/\D/g, '')
        const nonZeroDigits = digitsOnly.replace(/^0+/, '')
        const conds = [`invoice_no.ilike.%${invInput}%`]
        if (digitsOnly && digitsOnly !== invInput) conds.push(`invoice_no.ilike.%${digitsOnly}%`)
        if (nonZeroDigits && nonZeroDigits !== digitsOnly && nonZeroDigits !== invInput) conds.push(`invoice_no.ilike.%${nonZeroDigits}%`)
        q = q.or(conds.join(','))
      }

      if (phoneInput) {
        const digitsOnly = phoneInput.replace(/\D/g, '')
        if (digitsOnly && digitsOnly.length >= 4) {
          q = q.or(`phone.ilike.%${phoneInput}%,phone.ilike.%${digitsOnly}%`)
        } else {
          q = q.ilike('phone', `%${phoneInput}%`)
        }
      }

      if (custInput) {
        q = q.ilike('customer_name', `%${custInput}%`)
      }

      // Apply date filters — always apply them (overrides take priority over state for instant preset clicks)
      const effectiveDateFrom = dateFromOverride ?? search.dateFrom
      const effectiveDateTo   = dateToOverride   ?? search.dateTo
      if (effectiveDateFrom) q = q.gte('created_at', `${effectiveDateFrom}T00:00:00`)
      if (effectiveDateTo)   q = q.lte('created_at', `${effectiveDateTo}T23:59:59`)

      const effectiveBillType = billTypeOverride ?? billTypeFilter
      if (effectiveBillType === 'manual')       q = q.eq('order_type', 'manual_sale')
      else if (effectiveBillType === 'offline') q = q.eq('order_type', 'pos_sale').eq('order_mode', 'offline')
      else if (effectiveBillType === 'online')  q = q.eq('order_type', 'pos_sale').eq('order_mode', 'online')

      const { data, error } = await q
      if (error) throw error

      let results = (data || []).map(r => toDashboardOrder(r as Record<string, unknown>))

      // Client-side match filter to handle formatted invoice numbers (e.g. INV0000013 vs PB-20260716-000013)
      const matchOrder = (o: DashboardOrder) => {
        if (invInput) {
          const matchRaw = o.invoice_no.toLowerCase().includes(invInput.toLowerCase())
          const matchFmt = formatInvoiceNo(o.invoice_no).toLowerCase().includes(invInput.toLowerCase())
          const matchId  = o.id.toLowerCase() === invInput.toLowerCase()
          const invDigits = invInput.replace(/\D/g, '')
          const rawDigits = o.invoice_no.replace(/\D/g, '')
          const matchDigits = invDigits && (rawDigits.endsWith(invDigits) || rawDigits.includes(invDigits))
          if (!matchRaw && !matchFmt && !matchId && !matchDigits) return false
        }
        if (custInput) {
          const matchCust = o.customer_name.toLowerCase().includes(custInput.toLowerCase())
          if (!matchCust) return false
        }
        if (phoneInput) {
          const pDigits = phoneInput.replace(/\D/g, '')
          const rawPhoneDigits = o.phone.replace(/\D/g, '')
          const matchPhoneRaw = o.phone.toLowerCase().includes(phoneInput.toLowerCase())
          const matchPhoneDigits = Boolean(pDigits && rawPhoneDigits.includes(pDigits))
          if (!matchPhoneRaw && !matchPhoneDigits) return false
        }
        return true
      }

      if (hasQuery) {
        results = results.filter(matchOrder)
      }

      // Fallback: if query returned no results from Supabase, search in pre-loaded orders
      if (hasQuery && results.length === 0 && orders.length > 0) {
        const localMatches = orders.filter(o => {
          if (normalizeOrderType(o.order_type) === 'online_request') return false
          return matchOrder(o)
        })
        if (localMatches.length > 0) {
          results = localMatches
        }
      }

      setSearchResults(results.filter(o => !deletedOrderIds.current.has(o.id)))
    } catch (err) {
      console.error('Search error:', err)
      setSearchResults([])
    } finally {
      setSearchLoading(false)
    }
  }


  useEffect(() => {
    try {
      window.localStorage.setItem('dashboard-sidebar-collapsed', sidebarCollapsed ? '1' : '0')
    } catch {
      // Ignore persistence failures in private mode or restricted storage.
    }
  }, [sidebarCollapsed])

  // Auto-refresh analytics data every 30 seconds
  useEffect(() => {
    if (tab !== 'pos_analytics' || (posAnalyticsTab !== 'today' && posAnalyticsTab !== 'products' && posAnalyticsTab !== 'categories' && posAnalyticsTab !== 'coupons')) return
    const interval = setInterval(() => { void loadData() }, 30000)
    return () => clearInterval(interval)
  }, [tab, posAnalyticsTab, loadData])

  if (!isAdmin) return (
    <div className="min-h-screen bg-bgMain flex items-center justify-center p-4">
      <div className="bg-white p-8 rounded-3xl shadow-xl text-center max-w-sm">
        <AlertCircle className="mx-auto text-red-400 mb-4" size={48} />
        <h2 className="text-2xl font-black mb-2">{l('Unauthorized', 'அன� மதி இல� லை')}</h2>
        <Link to="/" className="px-6 py-3 bg-shopDeep border border-white/30 text-white rounded-xl font-bold inline-block mt-4 hover:bg-shopCard">{l('Go Home', 'ம� கப� பிற� க� ')}</Link>
      </div>
    </div>
  )

  const allNavItems: Array<{ id: TabKey; icon: React.ReactNode; label: string }> = [
    { id: 'billing',       icon: <ShoppingCart size={18} />,     label: 'Billing Panel' },
    { id: 'advance_orders',icon: <FileText size={18} />,         label: 'Advance Orders' },
    { id: 'inventory',     icon: <Package size={18} />,           label: 'Inventory' },
    { id: 'history',       icon: <List size={18} />,             label: 'Order History' },
    { id: 'pos_analytics', icon: <BarChart2 size={18} />,        label: 'Analytics Dashboard' },
    { id: 'coupons',       icon: <Box size={18} />,              label: 'Coupons' },
    { id: 'expenses',      icon: <Receipt size={18} />,          label: 'Expenses' },
    { id: 'attendance',    icon: <Users size={18} />,            label: 'Attendance' },
    { id: 'store_settings',icon: <Settings size={18} />,         label: 'Store Settings' },
  ]
  const navItems = allNavItems.filter(item => role === 'admin' || (item.id !== 'pos_analytics' && item.id !== 'coupons' && item.id !== 'expenses' && item.id !== 'store_settings'))

  return (
    <div className="admin-shell h-dvh min-h-dvh bg-bgMain flex flex-col lg:flex-row overflow-hidden">
      {unackedLoginLowStockItems.length > 0 && (
        <LowStockAlarmModal items={unackedLoginLowStockItems} onAcknowledge={acknowledgeLoginLowStockAlarm} />
      )}
      {/* Sidebar */}
      <aside
        className={[
          'w-full bg-maroon-dark text-white border-b lg:border-b-0 lg:border-r border-maroon-dark flex flex-col shrink-0 lg:h-full',
          'transition-[width] duration-300 ease-in-out overflow-hidden',
          sidebarCollapsed ? 'lg:w-[88px]' : 'lg:w-[260px]',
        ].join(' ')}
      >
        {/* Desktop brand header */}
        <div className={`hidden lg:flex items-center relative transition-all duration-300 ${sidebarCollapsed ? 'flex-col items-center pt-5 pb-4 px-2 gap-3' : 'px-5 py-5 justify-between'}`}>
          <Link to="/pos" title="Go to Billing Panel" className={`flex items-center gap-3 min-w-0 transition-all duration-300 ${sidebarCollapsed ? 'justify-center' : 'flex-1'}`}>
            <div className="flex items-center justify-center shrink-0 w-11 h-11 rounded-xl bg-shopDeep border border-white/30/70 shadow-sm overflow-hidden p-1 hover:scale-105 transition-transform">
              <img src={shopLogo} alt={`${shopName} logo`} className="w-full h-full object-cover" />
            </div>
            {!sidebarCollapsed && (
              <div className="min-w-0">
                <h1 className="text-[16px] font-black text-white leading-tight tracking-tight break-words">{shopName}</h1>
                <span className="mt-1 inline-block rounded-full border border-white/30 bg-shopAccent/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-white">
                  {role === 'admin' ? 'Admin Panel' : 'Staff Panel'}
                </span>
              </div>
            )}
          </Link>
          <button
            type="button"
            onClick={() => setSidebarCollapsed((state) => !state)}
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/10 text-white/80 hover:bg-white/15 hover:text-white transition-colors shrink-0"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ChevronDown size={16} className={`transition-transform duration-300 ${sidebarCollapsed ? '-rotate-90' : 'rotate-90'}`} />
          </button>
        </div>
        {/* Mobile mini-header */}
        <div className="flex lg:hidden items-center justify-between gap-2 px-3.5 py-2.5 border-b border-white/10">
          <Link to="/pos" title="Go to Billing Panel" className="flex items-center gap-2 min-w-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-shopDeep border border-white/30/70 shrink-0 overflow-hidden shadow-sm p-1 hover:scale-105 transition-transform">
              <img src={shopLogo} alt={`${shopName} logo`} className="w-full h-full object-cover" />
            </div>
            <span className="text-[12px] font-black text-white leading-tight break-words">{shopName}</span>
            <span className="shrink-0 rounded-full border border-white/30/50 bg-shopAccent/10 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-white">
              {role === 'admin' ? 'Admin' : 'Staff'}
            </span>
          </Link>
          <button
            onClick={() => {
              useAdminAuthStore.getState().logout()
              navigate('/admin-login', { replace: true })
            }}
            className="shrink-0 flex items-center gap-1 rounded-full bg-white/10 hover:bg-white/15 px-2.5 h-7 text-[10px] font-bold text-white transition-colors"
          >
            <Power size={12} /> Logout
          </button>
        </div>
        {/* Nav */}
        <nav
          className={`flex overflow-visible lg:flex-col gap-1 px-1.5 py-2 lg:gap-2 lg:py-2 lg:flex-grow transition-all duration-300 ${sidebarCollapsed ? 'lg:px-2' : 'lg:px-4'}`}
        >
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => handleTabClick(item.id)}
              title={item.label}
              className={[
                'flex-1 min-w-0 lg:flex-none lg:shrink-0 flex flex-col lg:flex-row items-center justify-center lg:justify-start',
                'gap-0.5 lg:gap-3',
                'h-11 lg:w-full lg:h-[48px]',
                sidebarCollapsed ? 'lg:w-[48px] lg:justify-center mx-auto' : 'lg:px-4',
                'px-0 py-1 lg:py-0',
                'rounded-lg lg:rounded-xl font-bold text-[10px] lg:text-[14px] transition-all overflow-hidden',
                tab === item.id ? 'bg-white text-shopDeep shadow-sm' : 'text-white/70 hover:bg-white/10 hover:text-white',
              ].join(' ')}
            >
              <span className="shrink-0 flex items-center gap-1">
                {item.icon}
              </span>
              <span className={`hidden lg:block truncate text-left transition-all duration-200 ${sidebarCollapsed ? 'w-0 opacity-0 overflow-hidden' : 'opacity-100 flex-1'}`}>
                {item.label}
              </span>
            </button>
          ))}
          {/* Logout button */}
          <button
            onClick={() => {
              useAdminAuthStore.getState().logout()
              navigate('/admin-login', { replace: true })
            }}
            className={[
              'hidden lg:flex lg:flex-none lg:shrink-0 items-center lg:justify-start',
              'lg:gap-3',
              'lg:w-full lg:h-[48px]',
              sidebarCollapsed ? 'lg:w-[48px] lg:justify-center mx-auto' : 'lg:px-4',
              'rounded-xl font-bold lg:text-[14px] transition-all text-white/70 hover:bg-red-500/15 hover:text-red-300 lg:mt-auto mb-1 lg:mb-4 overflow-hidden',
            ].join(' ')}
          >
            <span className="shrink-0"><Power size={20} /></span>
            <span className={`hidden lg:block truncate text-left transition-all duration-200 ${sidebarCollapsed ? 'w-0 opacity-0 overflow-hidden' : 'opacity-100 flex-1'}`}>Logout</span>
          </button>
        </nav>

      </aside>

      {/* Main */}
      <main className="flex-grow flex flex-col overflow-hidden">
        <div className="app-scroll-root flex-1 p-3 sm:p-6 lg:p-8 overflow-x-hidden overflow-y-auto hide-scrollbar">
        <div className="mx-auto w-full max-w-[1600px]">

        {/* ΓöÇΓöÇ ANALYTICS TAB ΓöÇΓöÇ */}

        {/* ── BUSINESS CONTROL CENTER ── */}
        {/* ── BUSINESS CONTROL CENTER ── */}
        {tab === 'overview' && (() => {
          const latestPOS = searchResults.slice(0, 10)
          return (
          <div className="space-y-6 rounded-[28px] bg-maroon-dark p-5 sm:p-6 lg:p-7 shadow-2xl border border-white/10 text-white">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-black text-white">{l('Analytics Dashboard', 'பகுப்பாய்வு தட்டு')}</h2>
              <div className="flex items-center gap-2">
                <button onClick={() => void loadData()}
                  className="flex items-center gap-1.5 px-3 py-2 bg-white border border-shopSoft/40 rounded-xl text-[12px] font-bold text-[#374151] hover:bg-[#F9FAFB]">
                  <RefreshCw size={13} /> {l('Refresh', 'புதுப்பி')}
                </button>
              </div>
            </div>

            <div className="flex gap-2 overflow-x-auto pb-2 border-b border-shopSoft/40">
              {[
                { id: 'revenue', label: 'Revenue' },
                { id: 'product', label: 'Product & Category' },
                { id: 'inventory', label: 'Inventory' },
                { id: 'customer', label: 'Customer' },
                { id: 'billing', label: 'Billing' },
              ].map(sub => (
                <button key={sub.id} onClick={() => setAnalyticsTab(sub.id)}
                  className={`px-4 py-2 rounded-xl text-[13px] font-bold whitespace-nowrap transition-colors ${analyticsTab === sub.id ? 'bg-[#111111] text-white' : 'bg-white border border-shopSoft/40 text-[#374151] hover:bg-[#F9FAFB]'}`}>
                  {sub.label}
                </button>
              ))}
            </div>

            {analyticsTab === 'revenue' && (
              <>

            {/* Revenue KPIs - 5 cards */}
            
            {lowStockProducts.length > 0 && (
              <div className="bg-red-50 rounded-2xl border border-red-100 p-4 shadow-sm mb-4">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle size={18} className="text-red-600" />
                  <h3 className="text-[13px] font-black text-red-800 uppercase tracking-wider">Low Stock Alerts ({lowStockProducts.length})</h3>
                </div>
                <div className="flex flex-wrap gap-2">
                  {lowStockProducts.map(p => (
                    <span key={p.id} className="bg-white border border-red-200 text-red-700 text-[11px] font-bold px-2.5 py-1 rounded-lg">
                      {p.name} — <span className="font-black">{p.stockQuantity}</span> left
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
              {[
                { label: l('Total Revenue', 'மொத்த வருவாய்'),    value: formatCurrency(analytics.totalCompletedRevenue), from: 'from-emerald-50 via-emerald-50/80 to-teal-50', iconBg: 'from-emerald-400 to-teal-500', icon: <RMIcon size={16} /> },
                { label: l("Today's Sales",  'இன்றைய விற்பனை'),  value: formatCurrency(analytics.todaySales),            from: 'from-blue-50 via-blue-50/80 to-indigo-50', iconBg: 'from-blue-400 to-indigo-500', icon: <TrendingUp size={16} /> },
                { label: l('Offline Revenue', 'ஆஃப்லைன் வருவாய்'), value: formatCurrency(analytics.posRevenue),           from: 'from-orange-50 via-orange-50/80 to-amber-50', iconBg: 'from-orange-400 to-amber-500', icon: <RMIcon size={16} /> },
                { label: l('Online Revenue',  'ஆன்லைன் வருவாய்'),  value: formatCurrency(analytics.onlinePosRevenue),     from: 'from-cyan-50 via-cyan-50/80 to-sky-50', iconBg: 'from-cyan-400 to-sky-500', icon: <RMIcon size={16} /> },
                { label: l('Manual Revenue',  'கைமுறை வருவாய்'),   value: formatCurrency(analytics.manualRevenue),        from: 'from-violet-50 via-violet-50/80 to-purple-50', iconBg: 'from-violet-400 to-purple-500', icon: <ShoppingCart size={16} /> },
              ].map((card, i) => (
                <div key={i} className={`bg-gradient-to-br ${card.from} rounded-2xl border border-white/40 p-4 shadow-sm backdrop-blur-sm`}>
                  <div className="flex items-center justify-between gap-1 mb-2">
                    <p className="text-[10px] uppercase font-black text-[#374151] tracking-wider leading-tight">{card.label}</p>
                    <div className={`w-7 h-7 rounded-xl bg-gradient-to-br ${card.iconBg} flex items-center justify-center text-white shrink-0 shadow-sm`}>{card.icon}</div>
                  </div>
                  <p className="text-[20px] font-black text-[#111111] break-words leading-tight">{card.value}</p>
                </div>
              ))}
            </div>

            {/* Latest POS Bills */}
            <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-black text-[#111111]">{l('Latest POS Bills', 'POS பில்கள்')}</h3>
                <button onClick={() => setTab('billing')} className="text-[12px] font-bold text-[#10B981] hover:underline">{l('View All →', 'அனைத்தும் →')}</button>
              </div>
              {latestPOS.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-shopSoft/30">
                  <table className="w-full min-w-[480px] text-[12px]">
                    <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
                      <tr>
                        <th className="px-3 py-2.5 font-black text-left">{l('Invoice', 'பில்')}</th>
                        <th className="px-3 py-2.5 font-black text-left">{l('Customer', 'வாடிக்கையாளர்')}</th>
                        <th className="px-3 py-2.5 font-black text-left">{l('Total', 'மொத்தம்')}</th>
                        <th className="px-3 py-2.5 font-black text-left">{l('Date', 'தேதி')}</th>
                        <th className="px-3 py-2.5 font-black text-left">{l('Type', 'வகை')}</th>
                        <th className="px-3 py-2.5 font-black text-left">{l('Status', 'நிலை')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-shopSoft/20">
                      {latestPOS.map(o => {
                        const btLabel = normalizeOrderType(o.order_type) === 'manual_sale' ? 'MANUAL' : normalizeOrderMode(o.order_mode) === 'online' ? 'ONLINE' : 'OFFLINE'
                        const btClass = normalizeOrderType(o.order_type) === 'manual_sale' ? 'bg-purple-100 text-purple-700' : normalizeOrderMode(o.order_mode) === 'online' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                        return (
                          <tr key={o.id} className="hover:bg-[#F9FAFB]/50">
                            <td className="px-3 py-2.5 font-bold text-[#10B981] text-[11px]">{formatInvoiceNo(o.invoice_no)}</td>
                            <td className="px-3 py-2.5 font-semibold text-[#111111] break-words">{o.customer_name}</td>
                            <td className="px-3 py-2.5 font-black text-[#111111]">{formatCurrency(getOrderTotal(o))}</td>
                            <td className="px-3 py-2.5 text-[#7A846F] whitespace-nowrap">{new Date(o.created_at).toLocaleDateString('en-MY', { day: '2-digit', month: 'short' })}</td>
                            <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${btClass}`}>{btLabel}</span></td>
                            <td className="px-3 py-2.5">
                              <span className={`text-[11px] font-black px-2 py-0.5 rounded-lg ${normalizeStatus(o.status) === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                {normalizeStatus(o.status)}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-[13px] text-[#374151] text-center py-4">{l('No bills yet', 'பில்கள் இல்லை')}</p>
              )}
            </div>
            </>
            )}

            {analyticsTab === 'product' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <h3 className="text-base font-black text-[#111111] mb-4">Top Products by Volume</h3>
                  <div className="space-y-3">
                    {analytics.topProducts.slice(0, 10).map((p, i) => (
                      <div key={i} className="flex justify-between items-center bg-[#F9FAFB] p-3 rounded-xl">
                        <div>
                          <p className="text-[13px] font-bold text-[#111111]">{p.name}</p>
                          <p className="text-[11px] text-[#374151]">{p.billCount} bills</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[14px] font-black text-[#111111]">{p.qty}</p>
                          <p className="text-[11px] font-bold text-[#10B981]">{formatCurrency(p.revenue)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <h3 className="text-base font-black text-[#111111] mb-4">Top Categories by Revenue</h3>
                  <div className="space-y-3">
                    {analytics.topCategories.slice(0, 10).map((c, i) => (
                      <div key={i} className="flex justify-between items-center bg-[#F9FAFB] p-3 rounded-xl">
                        <div>
                          <p className="text-[13px] font-bold text-[#111111]">{c.name}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[14px] font-black text-[#111111]">{formatCurrency(c.revenue)}</p>
                          <p className="text-[11px] text-[#374151]">{c.qty} sold</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {analyticsTab === 'inventory' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <h3 className="text-base font-black text-[#111111] mb-4">Low Stock Alerts</h3>
                  <div className="space-y-3">
                    {products.filter(p => p.stock <= (p.lowStockAlert || 5)).slice(0, 10).map((p, i) => (
                      <div key={i} className="flex justify-between items-center bg-red-50 border border-red-100 p-3 rounded-xl">
                        <p className="text-[13px] font-bold text-red-900">{p.name}</p>
                        <p className="text-[14px] font-black text-red-700">{p.stock} left</p>
                      </div>
                    ))}
                    {products.filter(p => p.stock <= (p.lowStockAlert || 5)).length === 0 && (
                      <p className="text-[13px] text-[#374151]">No low stock alerts.</p>
                    )}
                  </div>
                </div>
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <h3 className="text-base font-black text-[#111111] mb-4">Total Inventory Value</h3>
                  <div className="bg-[#F9FAFB] p-5 rounded-xl">
                    <p className="text-[11px] uppercase tracking-wider font-bold text-[#374151] mb-1">Selling Value (MRP)</p>
                    <p className="text-[24px] font-black text-[#111111]">
                      {formatCurrency(products.reduce((acc, p) => acc + (p.stock * p.price), 0))}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {analyticsTab === 'customer' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <h3 className="text-base font-black text-[#111111] mb-4">Customer Insights</h3>
                  <div className="bg-blue-50 border border-blue-100 p-5 rounded-xl mb-4">
                    <p className="text-[11px] uppercase tracking-wider font-bold text-blue-800 mb-1">Unique Customers</p>
                    <p className="text-[24px] font-black text-blue-900">
                      {new Set(searchResults.filter(o => o.phone).map(o => o.phone)).size}
                    </p>
                  </div>
                  <div className="bg-[#F9FAFB] p-5 rounded-xl">
                    <p className="text-[11px] uppercase tracking-wider font-bold text-[#374151] mb-1">Avg Order Value</p>
                    <p className="text-[24px] font-black text-[#111111]">
                      {formatCurrency(analytics.totalCompletedRevenue / (searchResults.filter(o => isCompletedStatus(o.status)).length || 1))}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {analyticsTab === 'billing' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <h3 className="text-base font-black text-[#111111] mb-4">Billing Metrics</h3>
                  <div className="space-y-4">
                    <div className="bg-[#F9FAFB] p-4 rounded-xl flex justify-between items-center">
                      <span className="text-[13px] font-bold text-[#374151]">Total Invoices Generated</span>
                      <span className="text-[16px] font-black text-[#111111]">{searchResults.length}</span>
                    </div>
                    <div className="bg-[#F9FAFB] p-4 rounded-xl flex justify-between items-center">
                      <span className="text-[13px] font-bold text-[#374151]">Discounts Applied</span>
                      <span className="text-[16px] font-black text-[#10B981]">
                        {formatCurrency(searchResults.reduce((acc, o) => acc + (toNumber(o.discount_amount, 0)), 0))}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <h3 className="text-base font-black text-[#111111] mb-4">Top Coupons</h3>
                  <div className="space-y-3">
                    {analytics.topCoupons.slice(0, 5).map((c, i) => (
                      <div key={i} className="flex justify-between items-center bg-[#F9FAFB] p-3 rounded-xl">
                        <span className="text-[13px] font-bold text-[#111111]">{c.code}</span>
                        <span className="text-[12px] font-bold text-[#10B981]">{c.usage} uses</span>
                      </div>
                    ))}
                    {analytics.topCoupons.length === 0 && <p className="text-[13px] text-[#374151]">No coupons used yet.</p>}
                  </div>
                </div>
              </div>
            )}
          </div>
          )
        })()}

        {/* ── WHATSAPP CENTER ── */}
        {tab === 'whatsapp' && (
          <div className="space-y-5">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-black text-[#111111]">{l('WhatsApp Center', 'வாட்ஸ் அப் மையம்')}</h2>
                {analytics.waPending > 0 && (
                  <span className="px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[12px] font-black animate-pulse">
                    {analytics.waPending} {l('pending', 'நிலுவை')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Compact period filter */}
                <div className="flex gap-1">
                  {(['all', 'today', 'week', 'month'] as const).map(preset => (
                    <button key={preset} type="button" onClick={() => applyAnalyticsPreset(preset)}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-black transition-colors ${analyticsDatePreset === preset ? 'bg-[#111111] text-white' : 'bg-[#F9FAFB] text-[#374151] hover:bg-shopSoft/40'}`}>
                      {preset === 'all' ? l('All','எல்லாம்') : preset === 'today' ? l('Today','இன்று') : preset === 'week' ? l('Week','வாரம்') : l('Month','மாதம்')}
                    </button>
                  ))}
                </div>
                <button onClick={() => void loadData()}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-shopSoft/40 rounded-lg text-[11px] font-bold text-[#374151] hover:bg-[#F9FAFB]">
                  <RefreshCw size={12} /> {l('Refresh', 'புதுப்பி')}
                </button>
              </div>
            </div>

            {/* Status summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: l('Total Requests', 'மொத்த கோரிக்கை'), val: analytics.waRequests,  bg: 'bg-blue-50',   color: 'text-blue-700',   border: 'border-blue-100' },
                { label: l('Pending', 'நிலுவை'),                 val: analytics.waPending,   bg: 'bg-amber-50',  color: 'text-amber-700',  border: 'border-amber-100' },
                { label: l('Contacted', 'தொடர்பு'),               val: analytics.waContacted, bg: 'bg-orange-50', color: 'text-orange-700', border: 'border-orange-100' },
                { label: l('Completed', 'முடிந்தது'),              val: analytics.waCompleted, bg: 'bg-green-50',  color: 'text-green-700',  border: 'border-green-100' },
              ].map(({ label, val, bg, color, border }) => (
                <div key={label} className={`${bg} border ${border} rounded-xl p-3 text-center`}>
                  <p className={`text-[10px] uppercase font-black ${color} tracking-wider mb-1`}>{label}</p>
                  <p className="text-[24px] xl:text-[20px] 2xl:text-[24px] font-black text-[#111111] leading-none truncate">{val}</p>
                </div>
              ))}
            </div>

            {/* ═══ CUSTOMER REQUEST MANAGEMENT - PRIMARY SECTION ═══ */}
            <div className="bg-white rounded-2xl border border-blue-200 shadow-sm">
              <div className="flex items-center justify-between px-5 py-4 border-b border-blue-100">
                <div className="flex items-center gap-2">
                  <MessageCircle size={17} className="text-blue-600" />
                  <h3 className="text-base font-black text-[#111111]">{l('Customer Requests', 'வாடிக்கையாளர் கோரிக்கைகள்')}</h3>
                  <span className="text-[10px] font-bold text-[#9BAB9A] bg-[#F9FAFB] px-2 py-0.5 rounded-full">{l('₹0 revenue - status updates only', '₹0 வருவாய் - நிலை மட்டும்')}</span>
                </div>
                <span className="text-[12px] text-[#374151] font-bold">{analytics.onlineRequestOrders.length} {l('requests', 'கோரிக்கைகள்')}</span>
              </div>

              {analytics.onlineRequestOrders.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] min-w-[820px]">
                    <thead className="bg-blue-50 border-b border-blue-100 sticky top-0 z-10">
                      <tr className="text-left text-[#374151] font-black text-[10px] uppercase tracking-wider">
                        <th className="px-4 py-3">{l('Customer', 'வாடிக்கையாளர்')}</th>
                        <th className="px-4 py-3">{l('Phone', 'தொலைபேசி')}</th>
                        <th className="px-4 py-3">{l('Address', 'முகவரி')}</th>
                        <th className="px-4 py-3 text-center">{l('Products', 'பொருட்கள்')}</th>
                        <th className="px-4 py-3">{l('Est. Total', 'மதிப்பீடு')}</th>
                        <th className="px-4 py-3">{l('Date & Time', 'தேதி & நேரம்')}</th>
                        <th className="px-4 py-3">{l('Status', 'நிலை')}</th>
                        <th className="px-4 py-3 text-center">{l('Details', 'விவரம்')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-blue-50">
                      {analytics.onlineRequestOrders.map(order => {
                        const its = parseOrderItems(order.items)
                        const isExpanded = waExpandedId === order.id

                        const normalizedItems = its.map(raw => normalizeStructuredOrderItem(raw as Record<string, unknown>))
                        const waMsg = buildProfessionalWhatsAppMessage({
                          customerName: order.customer_name,
                          phone: order.phone,
                          invoiceNumber: formatInvoiceNo(order.invoice_no || order.id),
                          invoiceDate: order.created_at,
                          items: normalizedItems.map(item => ({
                            name: item.name,
                            qty: item.quantity,
                            unit: item.unit,
                            unitType: item.unit_type,
                            rate: item.base_price,
                            lineTotal: item.line_total,
                          })),
                          subtotal: normalizedItems.reduce((sum, item) => sum + item.line_total, 0),
                          total: getOrderTotal(order),
                          paymentMode: order.payment_mode || order.payment_method,
                        })

                        return (
                          <React.Fragment key={order.id}>
                            <tr className={`hover:bg-blue-50/40 align-middle ${isExpanded ? 'bg-blue-50/30' : ''}`}>
                              <td className="px-4 py-3 font-bold text-[#111111] whitespace-nowrap">{order.customer_name || '-'}</td>
                              <td className="px-4 py-3 text-[#374151] whitespace-nowrap">{order.phone ? formatPhoneDisplay(order.phone) : '-'}</td>
                              <td className="px-4 py-3 text-[#7A846F] break-words" title={order.address || '-'}>{order.address || '-'}</td>
                              <td className="px-4 py-3 text-center">
                                <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-[11px] font-black">{its.length}</span>
                              </td>
                              <td className="px-4 py-3 font-black text-[#111111]">{formatCurrency(getOrderTotal(order))}</td>
                              <td className="px-4 py-3 text-[#7A846F] whitespace-nowrap text-[11px]">
                                <div>{new Date(order.created_at).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                                <div className="text-[10px]">{new Date(order.created_at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}</div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <select
                                    value={normalizeStatus(order.status)}
                                    onChange={e => void updateOrderStatus(order.id, e.target.value)}
                                    className={`text-[11px] font-black px-2 py-1.5 rounded-lg border cursor-pointer outline-none ${
                                      isCompletedStatus(order.status) ? 'bg-green-100 text-green-700 border-green-200'
                                      : normalizeStatus(order.status) === 'contacted' ? 'bg-orange-100 text-orange-700 border-orange-200'
                                      : 'bg-amber-100 text-amber-700 border-amber-200'
                                    }`}>
                                    <option value="pending">{l('Pending', 'நிலுவை')}</option>
                                    <option value="contacted">{l('Contacted', 'தொடர்பு')}</option>
                                    <option value="completed">{l('Completed', 'முடிந்தது')}</option>
                                  </select>
                                  <button onClick={() => void deleteOrder(order.id, order.invoice_no)} className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Delete Order">
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-center">
                                <button
                                  type="button"
                                  onClick={() => setWaExpandedId(isExpanded ? null : order.id)}
                                  className={`px-3 py-1.5 rounded-lg text-[11px] font-black transition-colors whitespace-nowrap ${
                                    isExpanded ? 'bg-[#111111] text-white' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                                  }`}>
                                  {isExpanded ? l('Close', 'மூடு') : l('View', 'பார்')}
                                </button>
                              </td>
                            </tr>

                            {/* Expanded detail row */}
                            {isExpanded && (
                              <tr>
                                <td colSpan={8} className="px-4 pb-5 pt-2 bg-blue-50/40">
                                  <div className="space-y-4">
                                    {/* Customer info bar */}
                                    <div className="flex flex-wrap gap-4 text-[12px] bg-white rounded-xl p-3 border border-blue-100">
                                      <div><span className="font-black text-[#374151]">{l('Name', 'பெயர்')}: </span><span className="font-bold text-[#111111]">{order.customer_name || '-'}</span></div>
                                      <div><span className="font-black text-[#374151]">{l('Phone', 'தொலைபேசி')}: </span><span className="font-bold text-[#111111]">{order.phone ? formatPhoneDisplay(order.phone) : '-'}</span></div>
                                      <div className="flex-1"><span className="font-black text-[#374151]">{l('Address', 'முகவரி')}: </span><span className="text-[#111111]">{order.address || '-'}</span></div>
                                      {Boolean(order.remarks) && (
                                        <div className="w-full mt-1 border-t border-blue-50 pt-2"><span className="font-black text-[#374151]">Remarks: </span><span className="font-bold text-[#111111]">{order.remarks}</span></div>
                                      )}
                                      {Boolean(order.reference_number) && (
                                        <div className="w-full mt-1 border-t border-blue-50 pt-2"><span className="font-black text-[#374151]">Ref Number: </span><span className="font-bold text-[#111111]">{order.reference_number}</span></div>
                                      )}
                                    </div>

                                    {/* Items table */}
                                    {its.length > 0 && (
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-[12px] min-w-[540px] bg-white rounded-xl overflow-hidden border border-blue-100">
                                          <thead className="bg-[#F9FAFB]">
                                            <tr className="text-left text-[#374151] font-black text-[10px] uppercase tracking-wider">
                                              <th className="px-4 py-2.5">{l('Product', 'பொருள்')}</th>
                                              <th className="px-4 py-2.5">{l('Variant', 'வகைப்படி')}</th>
                                              <th className="px-4 py-2.5">{l('Size / Weight', 'அளவு / எடை')}</th>
                                              <th className="px-4 py-2.5 text-center">{l('Qty', 'அளவு')}</th>
                                              <th className="px-4 py-2.5">{l('Unit Price', 'ஒரு விலை')}</th>
                                              <th className="px-4 py-2.5 text-right">{l('Line Total', 'வரி மொத்தம்')}</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-shopSoft/20">
                                            {its.map((raw, idx) => {
                                              const item = raw as Record<string, unknown>
                                              const fullName  = String(item.name || item.product_name || 'Product')
                                              const dashIdx   = fullName.indexOf(' - ')
                                              const prodName  = dashIdx > 0 ? fullName.slice(0, dashIdx) : fullName
                                              const variant   = dashIdx > 0 ? fullName.slice(dashIdx + 3) : '-'
                                              const qty       = toNumber(item.quantity ?? item.qty, 0)
                                              const basePrice = toNumber(item.base_price ?? item.basePrice ?? item.price, 0)
                                              const lineTotal = toNumber(item.line_total ?? item.lineTotal, 0)
                                              const unit      = String(item.unit || 'pc')
                                              const unitType  = String(item.unit_type || item.unitType || 'unit')
                                              const sizeLabel = unitType === 'weight'
                                                ? qty >= 1000 ? `${qty / 1000}kg` : `${qty}g`
                                                : unitType === 'volume'
                                                  ? qty >= 1000 ? `${qty / 1000}L` : `${qty}ml`
                                                  : `${qty} ${unit}`
                                              const priceLabel = formatCurrency(basePrice)
                                              return (
                                                <tr key={idx} className="hover:bg-blue-50/20">
                                                  <td className="px-4 py-2.5 font-bold text-[#111111]">{prodName}</td>
                                                  <td className="px-4 py-2.5 text-[#374151]">{variant}</td>
                                                  <td className="px-4 py-2.5 text-[#374151]">{sizeLabel}</td>
                                                  <td className="px-4 py-2.5 text-center font-bold">{qty}</td>
                                                  <td className="px-4 py-2.5 text-[#374151]">{priceLabel}</td>
                                                  <td className="px-4 py-2.5 font-black text-[#111111] text-right">{formatCurrency(lineTotal)}</td>
                                                </tr>
                                              )
                                            })}
                                          </tbody>
                                          <tfoot className="bg-[#F9FAFB] border-t border-shopSoft/30">
                                            <tr>
                                              <td colSpan={5} className="px-4 py-2.5 text-right font-black text-[#374151] text-[11px] uppercase tracking-wider">{l('Grand Total', 'மொத்த தொகை')}</td>
                                              <td className="px-4 py-2.5 text-right font-black text-[18px] text-[#111111]">{formatCurrency(getOrderTotal(order))}</td>
                                            </tr>
                                          </tfoot>
                                        </table>
                                      </div>
                                    )}

                                    {/* WhatsApp message */}
                                    <div className="bg-white rounded-xl border border-blue-100 p-4">
                                      <div className="flex items-center justify-between mb-2">
                                        <span className="text-[11px] font-black text-[#374151] uppercase tracking-wider">{l('WhatsApp Message', 'வாட்ஸ் அப் செய்தி')}</span>
                                        <button
                                          type="button"
                                          onClick={() => void navigator.clipboard.writeText(waMsg)}
                                          className="px-3 py-1 rounded-lg bg-[#25D366] text-white text-[11px] font-black hover:bg-[#1da851] transition-colors">
                                          {l('Copy Message', 'நகல் எடு')}
                                        </button>
                                      </div>
                                      <pre className="text-[12px] text-[#111111] bg-[#F9FAFB] rounded-xl p-3 whitespace-pre-wrap font-sans leading-relaxed select-all">{waMsg}</pre>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-5 py-12 text-center">
                  <MessageCircle size={40} className="mx-auto text-blue-200 mb-3" />
                  <p className="text-[14px] font-bold text-[#374151]">{l('No WhatsApp requests in selected period', 'தேர்ந்த காலத்தில் WA கோரிக்கை இல்லை')}</p>
                </div>
              )}
            </div>

            {/* ——— ANALYTICS - secondary, compact, bottom ——— */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Top Requested Products */}
              <div className="bg-white rounded-2xl border border-shopSoft/30 p-4 shadow-sm">
                <h3 className="text-[13px] font-black text-[#111111] mb-3">{l('Top Requested Products', 'அதிக தேவை')}</h3>
                {analytics.topWAProducts.length > 0 ? (
                  <div className="space-y-1.5">
                    {analytics.topWAProducts.slice(0, 6).map((item, i) => (
                      <div key={item.name} className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[9px] font-black flex items-center justify-center shrink-0">{i + 1}</span>
                        <span className="text-[11px] font-bold text-[#111111] truncate flex-1">{item.name}</span>
                        <span className="text-[11px] font-black text-blue-600 shrink-0">{item.count}x</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-[#9BAB9A] text-center py-3">{l('No data', 'தரவு இல்லை')}</p>
                )}
              </div>

              {/* Top Requested Categories */}
              <div className="bg-white rounded-2xl border border-shopSoft/30 p-4 shadow-sm">
                <h3 className="text-[13px] font-black text-[#111111] mb-3">{l('Top Categories', 'வகைகள்')}</h3>
                {analytics.topWACategories.length > 0 ? (
                  <div className="space-y-1.5">
                    {analytics.topWACategories.slice(0, 6).map((cat, i) => (
                      <div key={cat.name} className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-[9px] font-black flex items-center justify-center shrink-0">{i + 1}</span>
                        <span className="text-[11px] font-bold text-[#111111] truncate flex-1">{cat.name}</span>
                        <span className="text-[11px] font-black text-emerald-600 shrink-0">{cat.count}x</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-[#9BAB9A] text-center py-3">{l('No data', 'தரவு இல்லை')}</p>
                )}
              </div>

              {/* Status Distribution - compact bar */}
              <div className="bg-white rounded-2xl border border-shopSoft/30 p-4 shadow-sm">
                <h3 className="text-[13px] font-black text-[#111111] mb-3">{l('Status Distribution', 'நிலை விளக்கம்')}</h3>
                <div className="h-36">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.statusDistribution} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E8DFD0" />
                      <XAxis dataKey="name" tick={{ fill: '#6B7661', fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis allowDecimals={false} tick={{ fill: '#6B7661', fontSize: 9 }} axisLine={false} tickLine={false} width={24} />
                      <Tooltip formatter={(value) => toNumber(value as number | string, 0)} />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]} barSize={20}>
                        {analytics.statusDistribution.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ——— POS ANALYTICS ——— */}
        {tab === 'pos_analytics' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base sm:text-xl md:text-[24px] font-bold text-[#111111]">POS Analytics</h2>
              <p className="text-[12px] sm:text-[13px] text-[#6B7280]">Real time store & channel insights</p>
            </div>

            <div className="flex flex-col gap-4 border-b border-[#E7E7E7] pb-4 md:flex-row md:items-center md:justify-between">
              {/* Sub-tabs */}
              <div className="flex gap-2 overflow-x-auto md:flex-wrap md:overflow-visible hide-scrollbar bg-[#F3F4F6] rounded-2xl p-1.5">
                {([
                  { id: 'revenue' as const,    label: 'Revenue' },
                  { id: 'today' as const,      label: "Today's Sales" },
                  { id: 'products' as const,   label: 'Products' },
                  { id: 'coupons' as const,    label: 'Coupons' },
                ]).map(({ id, label }) => (
                  <button key={id} onClick={() => setPosAnalyticsTab(id as PosAnalyticsTab)}
                    className={`px-4 py-2 rounded-xl text-[12px] font-black tracking-wide transition-all whitespace-nowrap ${posAnalyticsTab === id ? 'bg-white text-shopCard shadow-sm' : 'text-[#6B7280] hover:text-[#111111]'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Date filter (hidden for Today's Sales) */}
              {posAnalyticsTab !== 'today' && (
                <div className="flex flex-col gap-3 md:items-end w-full md:w-auto">
                  <div className="flex items-center gap-2 rounded-2xl bg-[#F8F8F8] p-2 overflow-x-auto md:flex-wrap md:overflow-visible hide-scrollbar w-full md:w-auto">
                    <span className="shrink-0 text-[10px] font-bold uppercase text-[#6B7280] ml-1 mr-1">Period:</span>
                    {(['all', 'today', 'week', 'month', 'year'] as const).map(preset => (
                      <button key={preset} type="button" onClick={() => applyAnalyticsPreset(preset)}
                        className={`shrink-0 px-4 py-1.5 rounded-full text-[11px] font-bold uppercase transition-all whitespace-nowrap ${analyticsDatePreset === preset ? 'bg-maroon-dark text-white shadow-sm' : 'text-[#6B7280] hover:text-[#111111]'}`}>
                        {preset === 'all' ? 'All Time' : preset === 'today' ? 'Today' : preset === 'week' ? 'This Week' : preset === 'month' ? 'This Month' : 'This Year'}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 w-full">
                    <div className="flex items-center border border-[#E7E7E7] rounded-xl px-3 py-2 bg-white min-w-0">
                      <span className="text-[10px] uppercase font-bold text-[#6B7280] mr-2">From:</span>
                      <input type="date" value={analyticsDateFrom} onChange={e => { setAnalyticsDateFrom(e.target.value); setAnalyticsDatePreset('custom'); }} className="w-full min-w-0 text-[12px] font-semibold text-[#111111] bg-transparent outline-none" />
                    </div>
                    <div className="flex items-center border border-[#E7E7E7] rounded-xl px-3 py-2 bg-white min-w-0">
                      <span className="text-[10px] uppercase font-bold text-[#6B7280] mr-2">To:</span>
                      <input type="date" value={analyticsDateTo} onChange={e => { setAnalyticsDateTo(e.target.value); setAnalyticsDatePreset('custom'); }} className="w-full min-w-0 text-[12px] font-semibold text-[#111111] bg-transparent outline-none" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Revenue sub-tab */}
            {posAnalyticsTab === 'revenue' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
                  {[
                    { label: 'NET PROFIT',       helper: 'Total - COGS - Expenses', value: formatCurrency(analytics.netProfit),             icon: <TrendingUp size={16} />,  color: 'text-emerald-600', bg: 'bg-emerald-100' },
                    { label: 'TOTAL REVENUE',    helper: 'POS + Advance Orders',    value: formatCurrency(analytics.totalCompletedRevenue), icon: <RMIcon size={16} />,      color: 'text-blue-500',    bg: 'bg-blue-50' },
                    { label: 'PRODUCT REVENUE',  helper: 'POS Retail Sales',        value: formatCurrency(analytics.productRevenue),        icon: <Package size={16} />,     color: 'text-orange-500',  bg: 'bg-orange-50' },
                    { label: 'SERVICE REVENUE',  helper: 'Advance Orders',          value: formatCurrency(analytics.serviceRevenue),        icon: <FileText size={16} />,    color: 'text-cyan-500',    bg: 'bg-cyan-50' },
                    { label: 'TOTAL EXPENSES',   helper: 'All logged expenses',     value: formatCurrency(analytics.totalExpenses),         icon: <Receipt size={16} />,     color: 'text-red-500',     bg: 'bg-red-50' },
                  ].map((card, index) => (
                    <div key={index} className="bg-white rounded-card border border-borderLight p-5 shadow-soft">
                      <div className="flex items-start justify-between gap-2 mb-4">
                        <div>
                          <p className="text-[11px] font-bold text-[#111111] uppercase tracking-wider mb-1">{card.label}</p>
                        </div>
                        <div className={`w-8 h-8 rounded-full ${card.bg} flex items-center justify-center ${card.color}`}>{card.icon}</div>
                      </div>
                      <p className="text-[24px] xl:text-[20px] 2xl:text-[24px] font-bold text-[#111111] leading-none mb-2 truncate">{card.value}</p>
                      <p className="text-[12px] text-[#6B7280] truncate">{card.helper}</p>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
                  {[
                    { label: 'TOTAL OFFLINE BILLS', helper: 'Walk-in POS orders',    value: analytics.offlineOrderCount,                    icon: <LayoutDashboard size={16} />, color: 'text-red-500',    bg: 'bg-red-50' },
                    { label: 'TOTAL ONLINE BILLS',  helper: 'Live completed online bills', value: analytics.onlineBillCount,               icon: <Box size={16} />,             color: 'text-blue-500',   bg: 'bg-blue-50' },
                    { label: 'TOTAL ITEMS SOLD',    helper: 'From completed bills',  value: Math.round(analytics.totalProductsSold),         icon: <Box size={16} />,             color: 'text-purple-500', bg: 'bg-purple-50' },
                    { label: 'AVERAGE REVENUE PER BILL', helper: 'Average per Bill', value: formatCurrency(analytics.averageRevenuePerBill), icon: <RMIcon size={16} />, color: 'text-emerald-500', bg: 'bg-emerald-50' },
                    { label: 'TOP PRODUCT',         helper: 'Most sold item',        value: analytics.bestProduct || '-',                    icon: <Trophy size={16} />,          color: 'text-pink-500',   bg: 'bg-pink-50' },
                  ].map((card, index) => (
                    <div key={index} className="bg-white rounded-card border border-borderLight p-5 shadow-soft">
                      <div className="flex items-start justify-between gap-2 mb-4">
                        <div>
                          <p className="text-[11px] font-bold text-[#111111] uppercase tracking-wider mb-1">{card.label}</p>
                        </div>
                        <div className={`w-8 h-8 rounded-full ${card.bg} flex items-center justify-center ${card.color}`}>{card.icon}</div>
                      </div>
                      <p className="text-[22px] font-bold text-[#111111] leading-none mb-2 truncate">{card.value}</p>
                      <p className="text-[12px] text-[#6B7280] truncate">{card.helper}</p>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                  <div className="xl:col-span-2 bg-white rounded-card border border-borderLight p-6 shadow-soft">
                    <div className="flex items-center justify-between gap-4 mb-4">
                      <h3 className="text-[16px] font-bold text-[#111111]">Revenue Trend {analytics.chartYear}</h3>
                      <span className="text-[12px] font-bold text-maroon-dark bg-red-50 px-2.5 py-1 rounded-md">Avg {formatCurrency(analytics.monthlyRevenue || 0)}/mo</span>
                    </div>
                    <div className="h-64 mt-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={analytics.monthlyTrend}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F3F4F6" />
                          <XAxis dataKey="month" tick={{ fill: '#6B7280', fontSize: 11, fontWeight: 700 }} axisLine={false} tickLine={false} interval={0} angle={-45} textAnchor="end" height={60} />
                          <YAxis hide />
                          <Tooltip cursor={{ fill: '#F9FAFB' }} formatter={(value) => formatCurrency(toNumber(value as number | string, 0))} />
                          <Bar dataKey="revenue" fill="rgb(var(--shop-card-rgb))" radius={[4, 4, 0, 0]} maxBarSize={32} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div className="space-y-6">
                    <div className="bg-white rounded-card border border-borderLight p-6 shadow-soft">
                      <h3 className="text-[16px] font-bold text-[#111111] mb-6">Order Source</h3>
                      <div className="space-y-4">
                        <div>
                          <div className="flex justify-between text-[12px] font-bold mb-2">
                            <span className="text-maroon-dark uppercase">Offline</span>
                            <span className="text-[#111111]">{analytics.completedOrders}</span>
                          </div>
                          <div className="w-full bg-[#F3F4F6] rounded-full h-2.5">
                            <div className="bg-maroon-dark h-2.5 rounded-full" style={{ width: '100%' }}></div>
                          </div>
                        </div>
                        <div>
                          <div className="flex justify-between text-[12px] font-bold mb-2">
                            <span className="text-[#6B7280] uppercase">Online</span>
                            <span className="text-[#111111]">0</span>
                          </div>
                          <div className="w-full bg-[#F3F4F6] rounded-full h-2.5">
                            <div className="bg-[#E5E7EB] h-2.5 rounded-full" style={{ width: '0%' }}></div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-white rounded-card border border-borderLight p-6 shadow-soft">
                      <h3 className="text-[16px] font-bold text-[#111111] mb-4">Top Items by Revenue</h3>
                      <div className="space-y-3">
                        {analytics.topProducts.slice(0, 3).map((p, i) => (
                          <div key={i} className="flex items-start justify-between gap-2 text-[13px] min-w-0">
                            <div className="flex items-start gap-3 min-w-0 flex-1">
                              <span className="font-bold text-[#6B7280] w-4 shrink-0">{i + 1}</span>
                              <span className="font-bold text-[#111111] break-words">{p.name}</span>
                            </div>
                            <div className="flex items-center gap-4 shrink-0">
                              <span className="font-bold text-maroon-dark">{formatCurrency(p.revenue)}</span>
                              <span className="text-[#6B7280] text-[11px] w-8 text-right">{Math.round(p.qty)} pcs</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                  <div className="xl:col-span-2 bg-white rounded-card border border-borderLight p-6 shadow-soft">
                    <div className="flex items-center justify-between gap-3 mb-6">
                      <div>
                        <h3 className="text-[16px] font-bold text-[#111111]">Revenue Trend This Week</h3>
                        <p className="mt-1 text-[12px] text-[#6B7280]">Monday to Sunday sales view for the current week.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-[#F9FAFB] px-3 py-1 text-[11px] font-bold text-shopCard">
                          Week {(() => { const now = new Date(); const start = new Date(now.getFullYear(), 0, 1); const diff = Math.floor((now.getTime() - start.getTime()) / 86400000); return Math.ceil((diff + start.getDay() + 1) / 7) })()} of {new Date().getFullYear()}
                        </span>
                        <span className="rounded-full bg-[#F9FAFB] px-3 py-1 text-[11px] font-bold text-shopCard">
                          Today: {formatCurrency(analytics.todaySales)}
                        </span>
                      </div>
                    </div>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={analytics.weeklySales}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F3F4F6" />
                          <XAxis dataKey="day" tick={{ fill: '#6B7280', fontSize: 11, fontWeight: 700 }} axisLine={false} tickLine={false} />
                          <YAxis hide />
                          <Tooltip
                            cursor={{ fill: '#F9FAFB' }}
                            formatter={(value) => formatCurrency(toNumber(value as number | string, 0))}
                            labelFormatter={(_, payload) => {
                              const point = payload?.[0]?.payload as { day?: string; date?: string } | undefined
                              return point ? `${point.day || 'Day'} - ${point.date || ''}` : 'Weekly Revenue'
                            }}
                          />
                          <Bar dataKey="revenue" fill="#111111" radius={[4, 4, 0, 0]} barSize={28} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="bg-white rounded-card border border-borderLight p-6 shadow-soft">
                    <h3 className="text-[16px] font-bold text-[#111111] mb-4">Top Products This Week</h3>
                    <div className="space-y-3">
                      {analytics.topProducts.slice(0, 5).map((p, i) => (
                        <div key={`${p.name}-${i}`} className="flex items-center justify-between rounded-xl bg-[#F9FAFB] p-3">
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-bold text-[#111111]">{p.name}</p>
                            <p className="text-[11px] text-[#6B7280]">{p.billCount} bills</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[13px] font-black text-[#111111]">{Math.round(p.qty)}</p>
                            <p className="text-[11px] font-bold text-[#10B981]">{formatCurrency(p.revenue)}</p>
                          </div>
                        </div>
                      ))}
                      {analytics.topProducts.length === 0 && (
                        <p className="text-[13px] text-[#6B7280]">No completed product sales yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Today's Sales sub-tab */}
            {posAnalyticsTab === 'today' && (
              <div className="space-y-6">
                {/* Key metrics box grid row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { label: "TODAY'S REVENUE", value: formatCurrency(analytics.todaySales), icon: <RMIcon size={20} className="text-emerald-700" />, bg: 'bg-emerald-50', border: 'border-emerald-100' },
                    { label: "COMPLETED ORDERS", value: String(analytics.todayCompletedOrdersCount), icon: <ShoppingCart size={20} className="text-blue-700" />, bg: 'bg-blue-50', border: 'border-blue-100' },
                    { label: "ITEMS SOLD", value: String(Math.round(analytics.todayItemsSold)), icon: <Package size={20} className="text-purple-700" />, bg: 'bg-purple-50', border: 'border-purple-100' },
                    { label: "AVG ORDER VALUE", value: formatCurrency(analytics.todayAvgOrderValue), icon: <Trophy size={20} className="text-amber-700" />, bg: 'bg-amber-50', border: 'border-amber-100' },
                  ].map((card, i) => (
                    <div key={i} className="bg-white rounded-2xl border border-gray-200/80 p-4 sm:p-5 shadow-sm hover:shadow-md transition-shadow flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-extrabold uppercase tracking-wider text-gray-500 mb-1">{card.label}</p>
                        <p className="text-[22px] sm:text-[24px] font-black text-[#111111] leading-tight truncate">{card.value}</p>
                      </div>
                      <div className={`w-11 h-11 rounded-2xl ${card.bg} border ${card.border} flex items-center justify-center shrink-0 shadow-xs`}>
                        {card.icon}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Top products today */}
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <h3 className="text-[15px] font-bold text-[#111111] mb-4">Top Products Today</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {analytics.todayTopProducts.map((p, i) => (
                      <div key={i} className="flex items-center justify-between bg-[#F9FAFB] p-3 rounded-xl border border-gray-100">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-bold text-[#111111] truncate">{p.name}</p>
                          <p className="text-[11px] text-[#374151]">{Math.round(p.qty)} sold</p>
                        </div>
                        <p className="text-[13px] font-black text-[#10B981] ml-2">{formatCurrency(p.revenue)}</p>
                      </div>
                    ))}
                    {analytics.todayTopProducts.length === 0 && (
                      <p className="col-span-full text-center text-[13px] text-[#374151] py-6">No products sold yet today.</p>
                    )}
                  </div>
                </div>

                {/* Today's latest bills */}
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[15px] font-bold text-[#111111]">Today's Bills</h3>
                    <span className="text-[11px] font-bold text-[#10B981]">{analytics.todayCompletedOrdersCount} orders</span>
                  </div>
                  <div className="mb-3">
                    <input
                      type="text"
                      placeholder="Search by invoice number..."
                      value={todayBillsSearch}
                      onChange={e => setTodayBillsSearch(e.target.value)}
                      className="w-full px-4 py-2.5 bg-[#F9FAFB] border border-shopSoft/60 rounded-xl text-[13px] font-bold text-[#111111] placeholder:text-[#8A9384] focus:outline-none focus:border-shopCard transition-colors"
                    />
                  </div>
                  {(() => {
                    const filteredBills = analytics.todayBills.filter(b => !todayBillsSearch || b.invoice_no?.toLowerCase().includes(todayBillsSearch.toLowerCase()))
                    return filteredBills.length > 0 ? (
                    <div className="overflow-x-auto rounded-xl border border-shopSoft/30">
                      <table className="w-full min-w-[480px] text-[12px]">
                        <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
                          <tr>
                            <th className="px-3 py-2.5 font-black text-left">Invoice</th>
                            <th className="px-3 py-2.5 font-black text-left">Customer</th>
                            <th className="px-3 py-2.5 font-black text-left">Total</th>
                            <th className="px-3 py-2.5 font-black text-left">Time</th>
                            <th className="px-3 py-2.5 font-black text-left">Type</th>
                            <th className="px-3 py-2.5 font-black text-left">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-shopSoft/20">
                          {filteredBills.map(o => {
                            const btLabel = normalizeOrderType(o.order_type) === 'manual_sale' ? 'MANUAL' : normalizeOrderMode(o.order_mode) === 'online' ? 'ONLINE' : 'OFFLINE'
                            const btClass = normalizeOrderType(o.order_type) === 'manual_sale' ? 'bg-purple-100 text-purple-700' : normalizeOrderMode(o.order_mode) === 'online' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                            return (
                              <tr key={o.id} className="hover:bg-[#F9FAFB]/50">
                                <td className="px-3 py-2.5 font-bold text-[#10B981] text-[11px]">{formatInvoiceNo(o.invoice_no)}</td>
                                <td className="px-3 py-2.5 font-semibold text-[#111111] break-words">{o.customer_name}</td>
                                <td className="px-3 py-2.5 font-black text-[#111111]">{formatCurrency(getOrderTotal(o))}</td>
                                <td className="px-3 py-2.5 text-[#374151] whitespace-nowrap">{new Date(o.created_at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}</td>
                                <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${btClass}`}>{btLabel}</span></td>
                                <td className="px-3 py-2.5">
                                  <button onClick={() => void openOrderInvoice(o, 'view')} className="inline-flex items-center gap-1 rounded-lg border border-shopSoft/60 px-2 py-1.5 text-[11px] font-black text-[#111111] hover:bg-[#F9FAFB]" title="View Invoice">
                                    <Eye size={13} /> View Invoice
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-[13px] text-[#374151] text-center py-4">{todayBillsSearch ? 'No bills match your search.' : 'No bills yet today.'}</p>
                  )})()}
                </div>
              </div>
            )}

            {/* Products sub-tab */}
            {posAnalyticsTab === 'products' && (
              <div className="space-y-6">
                {/* Key metrics row: Revenue is 1st KPI card */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: 'Total Product Revenue', value: formatCurrency(analytics.totalCompletedRevenue), icon: <RMIcon size={18} />, from: 'from-emerald-500 to-teal-600' },
                    { label: 'Total Products Sold', value: String(Math.round(analytics.totalProductsSold)), icon: <Package size={18} />, from: 'from-blue-500 to-indigo-600' },
                    { label: 'Average Product Revenue', value: `${formatCurrency(analytics.averageProductRevenue)} / Product`, icon: <RMIcon size={18} />, from: 'from-violet-500 to-purple-600' },
                    { label: 'Top Product', value: analytics.bestProduct, icon: <Trophy size={18} />, from: 'from-amber-500 to-orange-600' },
                  ].map((card, i) => (
                    <div key={i} className={`relative overflow-hidden rounded-2xl p-5 shadow-lg border border-white/20 bg-gradient-to-br ${card.from}`}>
                      <div className="absolute inset-0 bg-gradient-to-tl from-white/30 via-white/10 to-transparent" />
                      <div className="relative z-10">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-[10px] uppercase font-black text-white/80 tracking-wider">{card.label}</p>
                          <div className="w-9 h-9 rounded-xl bg-white/25 backdrop-blur-sm flex items-center justify-center text-white shadow-sm">{card.icon}</div>
                        </div>
                        <p className="text-[15px] sm:text-[22px] font-extrabold text-white drop-shadow-sm leading-tight break-words">{card.value}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Full product table with Search by Name, SKU, Category */}
                <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                    <div>
                      <h3 className="text-[15px] font-bold text-[#111111]">All Products Analytics</h3>
                      <p className="text-[12px] text-[#6B7280]">Search by Product Name, SKU, or Category for instant statistics</p>
                    </div>
                    <span className="text-[11px] font-bold text-[#10B981] bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200 self-start sm:self-auto">{analytics.topProducts.length} products</span>
                  </div>
                  <div className="mb-4">
                    <input
                      type="text"
                      placeholder="Search by Product Name, SKU, or Category..."
                      value={productAnalyticsSearch}
                      onChange={e => setProductAnalyticsSearch(e.target.value)}
                      className="w-full px-4 py-2.5 bg-[#F9FAFB] border border-shopSoft/60 rounded-xl text-[13px] font-bold text-[#111111] placeholder:text-[#8A9384] focus:outline-none focus:border-shopCard transition-colors"
                    />
                  </div>
                  {(() => {
                    const filteredProds = analytics.topProducts.filter(p => {
                      if (!productAnalyticsSearch.trim()) return true
                      const q = productAnalyticsSearch.toLowerCase()
                      return p.name.toLowerCase().includes(q) || (p.variant && p.variant.toLowerCase().includes(q))
                    })
                    return filteredProds.length > 0 ? (
                      <>
                      <div className="overflow-x-auto rounded-xl border border-shopSoft/30">
                        <table className="w-full min-w-[640px] text-left text-[12px]">
                          <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
                            <tr>
                              <th className="px-4 py-2.5 font-black whitespace-nowrap">#</th>
                              <th className="px-4 py-2.5 font-black whitespace-nowrap">Product</th>
                              <th className="px-4 py-2.5 font-black whitespace-nowrap">Variant / SKU</th>
                              <th className="px-4 py-2.5 font-black whitespace-nowrap">Qty Sold</th>
                              <th className="px-4 py-2.5 font-black whitespace-nowrap">Revenue</th>
                              <th className="px-4 py-2.5 font-black whitespace-nowrap">Bills</th>
                              <th className="px-4 py-2.5 font-black whitespace-nowrap">Avg Revenue/Bill</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-shopSoft/20">
                            {filteredProds.slice(0, 50).map((p, i) => (
                              <tr key={`${p.name}-${p.variant || i}`} className="hover:bg-[#F9FAFB]/50">
                                <td className="px-4 py-2 text-[11px] text-[#9BAB9A] font-bold whitespace-nowrap">{i + 1}</td>
                                <td className="px-4 py-2 font-bold text-[#111111] whitespace-nowrap max-w-[180px] truncate">{p.name}</td>
                                <td className="px-4 py-2 text-[#374151] whitespace-nowrap">{p.variant || '-'}</td>
                                <td className="px-4 py-2 font-bold whitespace-nowrap">{Math.round(p.qty)}</td>
                                <td className="px-4 py-2 font-bold text-emerald-700 whitespace-nowrap">{formatCurrency(p.revenue)}</td>
                                <td className="px-4 py-2 text-[#374151] whitespace-nowrap">{p.billCount}</td>
                                <td className="px-4 py-2 font-bold text-[#111111] whitespace-nowrap">{formatCurrency(p.billCount > 0 ? p.revenue / p.billCount : 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      </>
                    ) : (
                      <p className="text-center text-[13px] text-[#374151] py-6">{productAnalyticsSearch ? 'No products match your search query.' : 'No product sales in selected period'}</p>
                    )
                  })()}
                </div>
              </div>
            )}

            {/* Categories sub-tab */}
            {posAnalyticsTab === 'categories' && (
              <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                <h3 className="text-base font-black text-[#111111] mb-4">{l('Category Analytics', 'வகை பகுப்பாய்வு')}</h3>
                {analytics.topCategories.length > 0 ? (
                  <>
                  <div className="space-y-3 md:hidden">
                    {analytics.topCategories.map((c, i) => (
                      <div key={c.name} className="rounded-2xl border border-shopSoft/30 bg-shopTint p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[13px] font-black text-[#9BAB9A]">#{i + 1}</p>
                            <p className="text-[16px] font-bold text-[#111111] break-words">{c.name}</p>
                          </div>
                          <p className="text-[14px] font-black text-emerald-700">{formatCurrency(c.revenue)}</p>
                        </div>
                        <div className="mt-3">
                          <p className="text-[#9BAB9A] uppercase text-[11px] font-black">Qty Sold</p>
                          <p className="font-bold text-[#111111]">{Math.round(c.qty)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="hidden md:block overflow-x-auto rounded-xl border border-shopSoft/30">
                    <table className="w-full text-left text-[13px]">
                      <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
                        <tr>
                          <th className="px-4 py-2.5 font-black">#</th>
                          <th className="px-4 py-2.5 font-black">{l('Category', 'வகை')}</th>
                          <th className="px-4 py-2.5 font-black">{l('Revenue', 'வருவாய்')}</th>
                          <th className="px-4 py-2.5 font-black">{l('Qty Sold', 'விற்ற அளவு')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-shopSoft/20">
                        {analytics.topCategories.map((c, i) => (
                          <tr key={c.name} className="hover:bg-[#F9FAFB]/50">
                            <td className="px-4 py-2 text-[11px] text-[#9BAB9A] font-bold">{i + 1}</td>
                            <td className="px-4 py-2 font-bold text-[#111111]">{c.name}</td>
                            <td className="px-4 py-2 font-bold text-emerald-700">{formatCurrency(c.revenue)}</td>
                            <td className="px-4 py-2 text-[#374151]">{Math.round(c.qty)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  </>
                ) : (
                  <p className="text-center text-[13px] text-[#374151] py-6">{l('No data in selected period', 'தேர்ந்த காலத்தில் தரவு இல்லை')}</p>
                )}
              </div>
            )}

            {/* Coupons sub-tab */}
            {posAnalyticsTab === 'coupons' && (
              <div className="space-y-6">
                {/* Key metrics row */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: 'Coupons Used', value: String(analytics.totalCouponOrders), icon: <ShoppingCart size={18} />, from: 'from-emerald-500 to-teal-600' },
                    { label: 'Total Discounts Given', value: formatCurrency(analytics.totalCouponDiscounts), icon: <RMIcon size={18} />, from: 'from-blue-500 to-indigo-600' },
                    { label: 'Usage Rate', value: `${analytics.couponUsageRate.toFixed(1)}%`, icon: <TrendingUp size={18} />, from: 'from-violet-500 to-purple-600' },
                    { label: 'Unique Coupons', value: String(analytics.topCoupons.length), icon: <Trophy size={18} />, from: 'from-amber-500 to-orange-600' },
                  ].map((card, i) => (
                    <div key={i} className={`relative overflow-hidden rounded-2xl p-5 shadow-lg border border-white/20 bg-gradient-to-br ${card.from}`}>
                      <div className="absolute inset-0 bg-gradient-to-tl from-white/30 via-white/10 to-transparent" />
                      <div className="relative z-10">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-[10px] uppercase font-black text-white/80 tracking-wider">{card.label}</p>
                          <div className="w-9 h-9 rounded-xl bg-white/25 backdrop-blur-sm flex items-center justify-center text-white shadow-sm">{card.icon}</div>
                        </div>
                        <p className="text-[22px] font-extrabold text-white drop-shadow-sm truncate">{card.value}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Coupon daily trend + Top coupons */}
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                  <div className="xl:col-span-2 bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                    <h3 className="text-[15px] font-bold text-[#111111] mb-4">Coupon Usage (Last 7 Days)</h3>
                    {analytics.couponDailyTrend.some(d => d.orders > 0) ? (
                      <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={analytics.couponDailyTrend}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F3F4F6" />
                            <XAxis dataKey="day" tick={{ fill: '#6B7280', fontSize: 11, fontWeight: 700 }} axisLine={false} tickLine={false} />
                            <YAxis hide />
                            <Tooltip cursor={{ fill: '#F9FAFB' }} formatter={(value, name) => [value, name === 'orders' ? 'Orders' : 'Discounts']} />
                            <Bar dataKey="orders" fill="url(#couponGrad)" radius={[4, 4, 0, 0]} barSize={24} />
                            <defs>
                              <linearGradient id="couponGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#10B981" />
                                <stop offset="100%" stopColor="#111111" />
                              </linearGradient>
                            </defs>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <p className="text-center text-[13px] text-[#374151] py-12">No coupon usage in the last 7 days.</p>
                    )}
                  </div>

                  <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                    <h3 className="text-[15px] font-bold text-[#111111] mb-4">Top Coupons</h3>
                    <div className="space-y-3">
                      {analytics.topCoupons.slice(0, 8).map((coupon, i) => (
                        <div key={coupon.code} className="flex items-center justify-between gap-2 p-3 bg-[#F9FAFB] rounded-xl">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-black text-[#9BAB9A]">{i + 1}</span>
                              <p className="text-[13px] font-bold text-[#111111] truncate">{coupon.code}</p>
                            </div>
                            <p className="text-[11px] text-[#374151] ml-5">{coupon.usage} order{coupon.usage > 1 ? 's' : ''}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-[13px] font-black text-emerald-700">{formatCurrency(coupon.discounts)}</p>
                            <p className="text-[10px] text-[#374151]">discounted</p>
                          </div>
                        </div>
                      ))}
                      {analytics.topCoupons.length === 0 && (
                        <p className="text-center text-[13px] text-[#374151] py-6">No coupon usage yet</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Coupon detail table */}
                {analytics.topCoupons.length > 0 && (
                  <div className="bg-white rounded-2xl border border-shopSoft/30 p-5 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-[15px] font-bold text-[#111111]">All Coupons Performance</h3>
                      <span className="text-[11px] font-bold text-[#10B981]">{analytics.topCoupons.length} coupons</span>
                    </div>
                    <div className="space-y-3 md:hidden">
                      {analytics.topCoupons.map((coupon, i) => (
                        <div key={coupon.code} className="rounded-2xl border border-shopSoft/30 bg-shopTint p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[13px] font-black text-[#9BAB9A]">#{i + 1}</p>
                              <p className="text-[16px] font-bold text-[#111111] break-words">{coupon.code}</p>
                            </div>
                            <p className="text-[14px] font-black text-emerald-700">{formatCurrency(coupon.discounts)}</p>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
                            <div>
                              <p className="text-[#9BAB9A] uppercase text-[11px] font-black">Orders</p>
                              <p className="font-bold text-[#111111]">{coupon.usage}</p>
                            </div>
                            <div>
                              <p className="text-[#9BAB9A] uppercase text-[11px] font-black">Avg Discount</p>
                              <p className="font-semibold text-[#374151]">{coupon.usage > 0 ? formatCurrency(coupon.discounts / coupon.usage) : '-'}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="hidden md:block overflow-x-auto rounded-xl border border-shopSoft/30">
                      <table className="w-full min-w-[400px] text-left text-[12px]">
                        <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
                          <tr>
                            <th className="px-4 py-2.5 font-black">#</th>
                            <th className="px-4 py-2.5 font-black">Code</th>
                            <th className="px-4 py-2.5 font-black">Orders</th>
                            <th className="px-4 py-2.5 font-black">Total Discount</th>
                            <th className="px-4 py-2.5 font-black">Avg Discount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-shopSoft/20">
                          {analytics.topCoupons.map((coupon, i) => (
                            <tr key={coupon.code} className="hover:bg-[#F9FAFB]/50">
                              <td className="px-4 py-2 text-[11px] text-[#9BAB9A] font-bold">{i + 1}</td>
                              <td className="px-4 py-2 font-bold text-[#111111]">{coupon.code}</td>
                              <td className="px-4 py-2 font-bold">{coupon.usage}</td>
                              <td className="px-4 py-2 font-bold text-emerald-700">{formatCurrency(coupon.discounts)}</td>
                              <td className="px-4 py-2 text-[#374151]">{coupon.usage > 0 ? formatCurrency(coupon.discounts / coupon.usage) : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── BILLING PANEL ── */}
        {tab === 'billing' && (
          <div className="-m-4 sm:-m-6 lg:-m-8">
            <Pos isEmbedded />
          </div>
        )}

        {tab === 'advance_orders' && <AdvanceOrders onOrderCompleted={() => void loadData()} />}

        {/* ── ORDER MANAGEMENT ── */}
        {tab === 'history' && (
          <div className="space-y-4 sm:space-y-6 rounded-[20px] sm:rounded-[28px] border border-shopSoft/60 bg-shopTint p-3 sm:p-6 lg:p-7 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] sm:text-[11px] font-black uppercase tracking-[0.24em] text-[#10B981]">{l('Billing history', 'பில் வரலாறு')}</p>
                <h2 className="mt-1 text-base sm:text-xl md:text-2xl font-black text-[#111111]">{l('Order Management', 'ஆர்டர் மேலாண்மை')} <span className="text-[11px] font-semibold text-[#374151]">({l('POS Bills only', 'POS பில்கள் மட்டுமே')})</span></h2>
              </div>
              <div className="flex gap-2">
                <Link to="/pos" className="inline-flex items-center gap-1.5 rounded-lg bg-[#111111] px-3 h-8 text-[12px] font-bold text-white shadow-sm hover:bg-shopDeep">
                  <ShoppingCart size={13} /> Open POS
                </Link>
              </div>
            </div>
            <div className="rounded-2xl border border-shopSoft/60 bg-white p-3 sm:p-6 shadow-sm">
              {/* Bill type filter */}
              <div className="flex flex-wrap gap-2 mb-4">
                {([
                  { v: 'all',     l: l('All Bills', 'அனைத்து') },
                  { v: 'offline', l: l('Offline', 'ஆஃப்லைன்') },
                  { v: 'online',  l: l('Online', 'ஆன்லைன்') },
                  { v: 'manual',  l: l('Manual', 'கைமுறை') },
                ] as const).map(({ v, l }) => (
                  <button key={v} type="button" onClick={() => { setBillTypeFilter(v); setTimeout(() => void runSearch(undefined, undefined, undefined, v), 0) }}
                    className={`min-h-[44px] px-3 py-1.5 rounded-xl text-[12px] font-black transition-colors ${billTypeFilter === v ? 'bg-[#111111] text-white shadow-sm' : 'bg-[#F9FAFB] text-[#374151] hover:bg-shopSoft/40'}`}>
                    {l}
                  </button>
                ))}
              </div>
              <form onSubmit={runSearch} className="space-y-3 mb-4">
                <div className="flex flex-wrap gap-2 items-center">
                  {(['today', 'week', 'month', 'custom'] as const).map(preset => (
                    <button key={preset} type="button" onClick={() => applyDatePreset(preset)}
                      className={`min-h-[44px] px-3 py-1.5 rounded-xl text-[12px] font-black transition-colors ${datePreset === preset ? 'bg-shopDeep text-shopAccent shadow-sm' : 'bg-[#F9FAFB] text-[#374151] hover:bg-shopSoft/40'}`}>
                      {preset === 'today' ? l('Today','இன்று') : preset === 'week' ? l('This Week','இந்த வாரம்') : preset === 'month' ? l('This Month','இந்த மாதம்') : l('Custom Range','தேர்வு')}
                    </button>
                  ))}
                  {(search.dateFrom || search.dateTo || datePreset) && (
                    <button type="button" onClick={() => { setDatePreset(''); setSearch(s => ({ ...s, dateFrom: '', dateTo: '' })); setTimeout(() => void runSearch(undefined, '', ''), 0) }}
                      className="min-h-[44px] px-3 py-1.5 rounded-xl text-[12px] font-black text-shopCard hover:bg-shopCard/5">{l('Clear Dates', 'தேதி அழி')}</button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <input className="min-h-[48px] rounded-xl bg-[#F9FAFB] px-3 py-2.5 text-[16px] md:text-[13px] font-semibold text-[#111111] placeholder:text-[#8A9384] focus:outline-none focus:ring-2 focus:ring-shopCard/15" placeholder={l('Invoice / Bill No', 'பில் எண்')}
                    value={search.invoiceNo} onChange={e => setSearch(s => ({ ...s, invoiceNo: e.target.value }))} />
                  <input className="min-h-[48px] rounded-xl bg-[#F9FAFB] px-3 py-2.5 text-[16px] md:text-[13px] font-semibold text-[#111111] placeholder:text-[#8A9384] focus:outline-none focus:ring-2 focus:ring-shopCard/15" placeholder={l('Customer Name', 'வாடிக்கையாளர் பெயர்')}
                    value={search.customerName} onChange={e => setSearch(s => ({ ...s, customerName: e.target.value }))} />
                  <input className="min-h-[48px] rounded-xl bg-[#F9FAFB] px-3 py-2.5 text-[16px] md:text-[13px] font-semibold text-[#111111] placeholder:text-[#8A9384] focus:outline-none focus:ring-2 focus:ring-shopCard/15" placeholder={l('Mobile Number', 'மொபைல் எண்')}
                    value={search.phone} onChange={e => setSearch(s => ({ ...s, phone: e.target.value }))} />
                  {datePreset === 'custom' ? (
                    <>
                      <input type="date" className="min-h-[48px] rounded-xl bg-[#F9FAFB] px-3 py-2.5 text-[16px] md:text-[13px] font-semibold text-[#111111] focus:outline-none focus:ring-2 focus:ring-shopCard/15"
                        value={search.dateFrom} onChange={e => setSearch(s => ({ ...s, dateFrom: e.target.value }))} />
                      <input type="date" className="min-h-[48px] rounded-xl bg-[#F9FAFB] px-3 py-2.5 text-[16px] md:text-[13px] font-semibold text-[#111111] focus:outline-none focus:ring-2 focus:ring-shopCard/15"
                        value={search.dateTo} onChange={e => setSearch(s => ({ ...s, dateTo: e.target.value }))} />
                    </>
                  ) : (
                    <button type="submit" disabled={searchLoading}
                      className="sm:col-span-2 min-h-[48px] flex items-center justify-center gap-2 rounded-xl bg-shopDeep border border-shopAccent py-2.5 text-[13px] font-bold text-shopAccent shadow-sm transition-colors hover:bg-shopDeep disabled:opacity-60">
                      <Search size={14} /> {searchLoading ? l('Searching...','தேடுகிறது...') : l('Search Bills','தேடு')}
                    </button>
                  )}
                  {datePreset === 'custom' && (
                    <button type="submit" disabled={searchLoading}
                      className="sm:col-span-2 lg:col-span-4 min-h-[48px] flex items-center justify-center gap-2 rounded-xl bg-shopDeep border border-shopAccent py-2.5 text-[13px] font-bold text-shopAccent shadow-sm transition-colors hover:bg-shopDeep disabled:opacity-60">
                      <Search size={14} /> {searchLoading ? l('Searching...','தேடுகிறது...') : l('Search Bills','தேடு')}
                    </button>
                  )}
                </div>
              </form>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-semibold text-[#374151]">{filteredSearchResults.length} {l('result(s)', 'முடிவுகள்')}</p>
                {filteredSearchResults.length > 0 && (
                  <button onClick={() => exportCSV(filteredSearchResults)}
                    className="flex items-center gap-1 text-[11px] font-bold text-shopCard hover:underline">
                    <Download size={11} /> Export CSV
                  </button>
                )}
              </div>
              <div className="space-y-3 md:hidden">
                {filteredSearchResults.slice(0, 50).map(o => {
                  const billTypeLabel = normalizeOrderType(o.order_type) === 'manual_sale' ? 'MANUAL' : normalizeOrderMode(o.order_mode) === 'online' ? 'ONLINE' : 'OFFLINE'
                  const billTypeClass = normalizeOrderType(o.order_type) === 'manual_sale' ? 'bg-purple-50 text-purple-700' : normalizeOrderMode(o.order_mode) === 'online' ? 'bg-blue-50 text-blue-700' : 'bg-orange-50 text-orange-700'
                  return (
                    <div key={o.id} className="rounded-2xl border border-shopSoft/60 bg-shopTint p-3 sm:p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[13px] font-black text-[#111111] break-words">{formatInvoiceNo(o.invoice_no)}</p>
                          <p className="text-[13px] text-[#374151]">{new Date(o.created_at).toLocaleDateString('en-MY')}</p>
                        </div>
                        <span className={`px-2 py-1 rounded-full text-[10px] font-black uppercase ${billTypeClass}`}>{billTypeLabel}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:gap-3 text-[12px] sm:text-[13px]">
                        <div className="min-w-0">
                          <p className="text-[#9BAB9A] uppercase text-[10px] sm:text-[11px] font-black">Customer</p>
                          <p className="font-bold text-[#111111] truncate">{o.customer_name || '—'}</p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[#9BAB9A] uppercase text-[10px] sm:text-[11px] font-black">Phone</p>
                          <p className="font-semibold text-[#374151] truncate">{o.phone ? formatPhoneDisplay(o.phone) : '—'}</p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[#9BAB9A] uppercase text-[10px] sm:text-[11px] font-black">Total</p>
                          <p className="font-black text-[#111111]">{formatCurrency(getOrderTotal(o))}</p>
                        </div>
                        <div>
                          <p className="text-[#9BAB9A] uppercase text-[11px] font-black">Coupon</p>
                          <p className="font-semibold text-[#374151] break-words">{o.coupon_code || '—'}</p>
                        </div>
                        <div>
                          <p className="text-[#9BAB9A] uppercase text-[11px] font-black">Discount</p>
                          <p className="font-semibold text-emerald-700">{o.discount_amount > 0 ? `-${formatCurrency(o.discount_amount)}` : '—'}</p>
                        </div>
                        <div>
                          <p className="text-[#9BAB9A] uppercase text-[11px] font-black">Delivery</p>
                          <p className="font-semibold text-[#111111]">{o.delivery_charge > 0 ? formatCurrency(o.delivery_charge) : '—'}</p>
                        </div>
                        {((o as unknown as Record<string,unknown>).reference_number as string) && (
                          <div>
                            <p className="text-[#9BAB9A] uppercase text-[11px] font-black">Ref #</p>
                            <p className="font-semibold text-[#111111] break-words">{(o as unknown as Record<string,unknown>).reference_number as string}</p>
                          </div>
                        )}
                        {((o as unknown as Record<string,unknown>).remarks as string) && (
                          <div className="col-span-2">
                            <p className="text-[#9BAB9A] uppercase text-[11px] font-black">Remarks</p>
                            <p className="font-semibold text-[#374151] break-words">{(o as unknown as Record<string,unknown>).remarks as string}</p>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-2 pt-1">
                        <select value={normalizeStatus(o.status)} onChange={e => void updateOrderStatus(o.id, e.target.value)}
                          className={`w-full h-10 cursor-pointer rounded-xl border px-3 py-2 text-[12px] font-black outline-none ${normalizeStatus(o.status) === 'completed' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                          <option value="pending">{l('Pending', 'நிலுவை')}</option>
                          <option value="completed">{l('Completed', 'முடிந்தது')}</option>
                        </select>
                        <div className="flex flex-row gap-2 w-full">
                          <button onClick={() => void openOrderInvoice(o, 'view')} className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-shopSoft/60 px-2 text-[12px] font-black text-[#111111] transition-colors hover:bg-white" title="View Invoice">
                            <Eye size={14} /> View
                          </button>
                          <button onClick={() => window.open(`/invoice/${o.id}`, '_blank')} className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-green-500 px-2 text-[12px] font-black text-white transition-colors hover:bg-green-600" title="Invoice & Share">
                            <MessageCircle size={14} /> Share
                          </button>
                          {role === 'admin' && (
                            <button onClick={() => void deleteOrder(o.id, o.invoice_no)} className="h-10 w-10 shrink-0 rounded-xl border border-shopSoft/60 text-shopCard transition-colors hover:bg-shopCard/5" title="Delete Order">
                              <Trash2 size={14} className="mx-auto" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {filteredSearchResults.length === 0 && (
                  <div className="rounded-2xl border border-shopSoft/60 bg-shopTint px-4 py-8 text-center text-[#374151]">{l('No matching bills', 'பில்கள் இல்லை')}</div>
                )}
              </div>
              <div className="hidden md:block overflow-x-auto rounded-xl border border-shopSoft/60 bg-shopTint">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
                    <tr>
                      {['Invoice No', 'Customer Name', 'Phone', 'Bill Type', 'Coupon', 'Discount', 'Delivery', 'Total', 'Date', 'Status', 'Actions', 'Details'].map(h => (
                        <th key={h} className="px-2 py-3 font-black text-center">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-shopSoft/30 bg-white">
                    {filteredSearchResults.slice(0, 50).map(o => {
                      const billTypeLabel = normalizeOrderType(o.order_type) === 'manual_sale' ? 'MANUAL' : normalizeOrderMode(o.order_mode) === 'online' ? 'ONLINE' : 'OFFLINE'
                      const billTypeClass = normalizeOrderType(o.order_type) === 'manual_sale' ? 'bg-purple-50 text-purple-700' : normalizeOrderMode(o.order_mode) === 'online' ? 'bg-blue-50 text-blue-700' : 'bg-orange-50 text-orange-700'
                      return (
                        <React.Fragment key={o.id}>
                        <tr key={o.id} className="hover:bg-[#F9FAFB] text-center">
                          <td className="whitespace-nowrap px-2 py-3 text-[11px] font-bold text-[#111111]">{formatInvoiceNo(o.invoice_no)}</td>
                          <td className="max-w-[100px] truncate px-2 py-3 text-[11px] font-semibold text-[#111111]">{o.customer_name}</td>
                          <td className="whitespace-nowrap px-2 py-3 text-[11px] text-[#374151]">{o.phone ? formatPhoneDisplay(o.phone) : ''}</td>
                          <td className="px-2 py-3"><span className={`px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase ${billTypeClass}`}>{billTypeLabel}</span></td>
                          <td className="px-2 py-3 text-[11px]">
                            {o.coupon_code ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">{o.coupon_code}</span> : <span className="text-[#9BAB9A]">—</span>}
                          </td>
                          <td className="px-2 py-3 text-[11px]">
                            {o.discount_amount > 0 ? <span className="font-bold text-emerald-700">-{formatCurrency(o.discount_amount)}</span> : <span className="text-[#9BAB9A]">—</span>}
                          </td>
                          <td className="px-2 py-3 text-[11px]">
                            {o.delivery_charge > 0 ? <span className="font-bold text-[#111111]">{formatCurrency(o.delivery_charge)}</span> : <span className="text-[#9BAB9A]">—</span>}
                          </td>
                          <td className="whitespace-nowrap px-2 py-3 text-[11px] font-bold text-[#111111]">{formatCurrency(getOrderTotal(o))}</td>
                          <td className="whitespace-nowrap px-2 py-3 text-[11px] text-[#374151]">{new Date(o.created_at).toLocaleDateString('en-MY')}</td>
                          <td className="px-2 py-3">
                            <div className="flex items-center justify-center gap-1.5">
                              <select value={normalizeStatus(o.status)} onChange={e => void updateOrderStatus(o.id, e.target.value)}
                                className={`cursor-pointer rounded-lg border px-1.5 py-1 text-[10px] font-black outline-none ${normalizeStatus(o.status) === 'completed' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                                <option value="pending">{l('Pending', 'நிலுவை')}</option>
                                <option value="completed">{l('Completed', 'முடிந்தது')}</option>
                              </select>
                              {role === 'admin' && (
                                <button onClick={() => void deleteOrder(o.id, o.invoice_no)} className="rounded-lg p-1 text-shopCard transition-colors hover:bg-shopCard/5" title="Delete Order">
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-3">
                            <div className="flex items-center justify-center gap-1">
                              <button onClick={() => void openOrderInvoice(o, 'view')} className="rounded-lg p-1 text-[#111111] transition-colors hover:bg-[#F9FAFB]" title="View Invoice">
                                <Eye size={13} />
                              </button>
                              <button onClick={() => window.open(`/invoice/${o.id}`, '_blank')} className="rounded-lg p-1.5 text-green-600 transition-colors hover:bg-green-50" title="Invoice & Share">
                                <MessageCircle size={14} />
                              </button>
                            </div>
                          </td>
                          <td className="px-2 py-3 text-center">
                            <button
                              onClick={() => setHistoryExpandedId(historyExpandedId === o.id ? null : o.id)}
                              className={`rounded-lg p-1 transition-colors ${
                                historyExpandedId === o.id
                                  ? 'bg-[#111111] text-white'
                                  : 'text-[#374151] hover:bg-[#F9FAFB]'
                              }`}
                              title="View Details"
                            >
                              <ChevronDown size={13} className={`transition-transform ${historyExpandedId === o.id ? 'rotate-180' : ''}`} />
                            </button>
                          </td>
                        </tr>
                        {historyExpandedId === o.id && (
                          <tr className="bg-[#F9FAFB] border-b border-shopSoft/40">
                            <td colSpan={12} className="px-4 py-4">
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-[12px]">
                                <div>
                                  <p className="text-[10px] font-black uppercase text-[#9BAB9A] tracking-wider mb-1">Prepared By</p>
                                  <p className="font-semibold text-[#111111]">{(o as unknown as Record<string,unknown>).tailor_name as string || '—'}</p>
                                </div>
                                <div>
                                  <p className="text-[10px] font-black uppercase text-[#9BAB9A] tracking-wider mb-1">Reference No</p>
                                  <p className="font-semibold text-[#111111]">{(o as unknown as Record<string,unknown>).reference_number as string || '—'}</p>
                                </div>
                                <div>
                                  <p className="text-[10px] font-black uppercase text-[#9BAB9A] tracking-wider mb-1">Remarks</p>
                                  <p className="font-semibold text-[#374151] break-words">{(o as unknown as Record<string,unknown>).remarks as string || '—'}</p>
                                </div>
                                <div>
                                  <p className="text-[10px] font-black uppercase text-[#9BAB9A] tracking-wider mb-1">Customer</p>
                                  <p className="font-semibold text-[#111111]">{o.customer_name}</p>
                                </div>
                                <div>
                                  <p className="text-[10px] font-black uppercase text-[#9BAB9A] tracking-wider mb-1">Address</p>
                                  <p className="font-semibold text-[#374151] break-words">{o.address || '—'}</p>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      )
                    })}
                    {filteredSearchResults.length === 0 && (
                      <tr><td colSpan={12} className="px-4 py-8 text-center text-[#374151]">{l('No matching bills', 'பில்கள் இல்லை')}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}


        {/* ── COUPONS TAB ── */}
        {/* ── COUPONS TAB ── */}
        {tab === 'coupons' && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 className="text-base sm:text-xl lg:text-[24px] leading-tight font-black text-[#111111]">{l('Coupon Management', 'கூப்பன் மேலாண்மை')}</h2>
                  <p className="max-w-2xl text-[12px] lg:text-[12px] font-medium text-[#6C665C]">
                    {l('Create and manage discount codes. Applies to product subtotal only.', 'பொருட்களின் subtotal-க்கு மட்டும் கூப்பன் தள்ளுபடி பொருந்தும்.')}
                  </p>
                </div>
                <button
                  onClick={() => void loadCoupons()}
                  className="inline-flex items-center gap-2 rounded-full border border-shopSoft bg-shopTint px-3 py-2 text-[11px] font-black text-shopCard shadow-sm transition-colors hover:bg-[#F7F1E7]"
                >
                  <RefreshCw size={12} />
                  Refresh
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  { label: 'Total Coupons', value: coupons.length, Icon: Tag, iconBg: 'bg-[#FFF8F2]', iconColor: 'text-shopCard' },
                  { label: 'Active', value: coupons.filter(c => c.is_active).length, Icon: CheckCircle2, iconBg: 'bg-emerald-50', iconColor: 'text-emerald-600' },
                  { label: 'Used', value: coupons.reduce((acc, c) => acc + (c.usage_count || 0), 0), Icon: Repeat, iconBg: 'bg-blue-50', iconColor: 'text-blue-600' },
                ].map((c, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-2xl border border-shopSoft bg-white px-4 py-3 shadow-sm">
                    <span className={`shrink-0 flex h-10 w-10 items-center justify-center rounded-xl ${c.iconBg} ${c.iconColor}`}>
                      <c.Icon size={18} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-[0.15em] text-[#9CA3AF]">{c.label}</p>
                      <p className="text-[20px] font-black text-[#111111]">{c.value}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-[#E7CFAA] bg-[#FFF6E7] px-3 py-2 text-[11px] font-bold text-shopCard shadow-sm">
                {l('Coupon discount applies to product subtotal only - not delivery charge.', 'கூப்பன் தள்ளுபடி பொருட்களின் subtotal-க்கு மட்டும் பொருந்தும்.')}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
              <form onSubmit={saveCoupon} className="rounded-2xl border border-shopSoft bg-[#FFFCF6] p-4 shadow-sm space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.15em] text-shopCard">{editingCouponId !== null ? 'Edit mode' : 'New coupon'}</p>
                    <h3 className="mt-1 text-[17px] font-black text-[#111111]">
                      {editingCouponId !== null ? l('Edit Coupon', 'கூப்பனை திருத்து') : l('Create Coupon', 'புதிய கூப்பன்')}
                    </h3>
                  </div>
                  {editingCouponId !== null && (
                    <button
                      type="button"
                      onClick={cancelEditCoupon}
                      className="rounded-full border border-[#E7CFAA] bg-[#FFF6E7] px-2.5 py-1 text-[11px] font-black text-shopCard transition-colors hover:bg-[#FBEBD3]"
                    >
                      Cancel
                    </button>
                  )}
                </div>

                {couponSaveError && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] font-bold text-red-700">
                    {couponSaveError}
                  </div>
                )}
                {couponSaveSuccess && (
                  <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-[12px] font-bold text-green-700">
                    {couponSaveSuccess}
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="block text-[10px] font-black uppercase tracking-[0.15em] text-[#6B7280]">{l('Coupon Code', 'கூப்பன் குறியீடு')} *</label>
                  <div className="flex gap-2">
                    <input
                      className="flex-1 rounded-xl border border-shopSoft bg-white px-3 py-2.5 text-[12px] font-black uppercase tracking-[0.12em] text-[#111111] outline-none transition-colors focus:border-shopCard"
                      placeholder="WELCOME10"
                      value={couponForm.code}
                      disabled={editingCouponId !== null}
                      onChange={e => { setCouponForm(f => ({ ...f, code: e.target.value.toUpperCase() })); setCouponSaveError(''); setCouponSaveSuccess('') }}
                    />
                    {editingCouponId === null && (
                      <button
                        type="button"
                        onClick={generateCouponCode}
                        className="shrink-0 rounded-xl border border-shopAccent bg-shopDeep px-3 py-2.5 text-[11px] font-black text-shopAccent transition-colors hover:bg-shopDeep"
                      >
                        Generate
                      </button>
                    )}
                  </div>
                  {editingCouponId !== null && (
                    <p className="text-[10px] font-medium text-[#6B7280]">{l('Code cannot be changed when editing', 'திருத்தும்போது குறியீட்டை மாற்ற முடியாது')}</p>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-black uppercase tracking-[0.15em] text-[#6B7280]">{l('Discount %', 'தள்ளுபடி %')} *</label>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      className="w-full rounded-xl border border-shopSoft bg-white px-3 py-2.5 text-[12px] font-bold text-[#111111] outline-none transition-colors focus:border-shopCard"
                      placeholder="10"
                      value={couponForm.percentage}
                      onChange={e => setCouponForm(f => ({ ...f, percentage: Number(e.target.value) }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-black uppercase tracking-[0.15em] text-[#6B7280]">{l('Min Order (₹)', 'குறைந்த ஆர்டர் (₹)')}</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full rounded-xl border border-shopSoft bg-white px-3 py-2.5 text-[12px] font-bold text-[#111111] outline-none transition-colors focus:border-shopCard"
                      placeholder="0 = no minimum"
                      value={couponForm.min_order_value}
                      onChange={e => setCouponForm(f => ({ ...f, min_order_value: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-black uppercase tracking-[0.15em] text-[#6B7280]">{l('Expiry Date', 'காலாவதி தேதி')}</label>
                    <input
                      type="date"
                      className="w-full rounded-xl border border-shopSoft bg-white px-3 py-2.5 text-[12px] font-bold text-[#111111] outline-none transition-colors focus:border-shopCard"
                      value={couponForm.expiry_date}
                      onChange={e => setCouponForm(f => ({ ...f, expiry_date: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-black uppercase tracking-[0.15em] text-[#6B7280]">{l('Usage Limit', 'பயன்பாட்டு வரம்பு')}</label>
                    <input
                      type="number"
                      min="1"
                      className="w-full rounded-xl border border-shopSoft bg-white px-3 py-2.5 text-[12px] font-bold text-[#111111] outline-none transition-colors focus:border-shopCard"
                      placeholder="Unlimited"
                      value={couponForm.usage_limit}
                      onChange={e => setCouponForm(f => ({ ...f, usage_limit: e.target.value }))}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full rounded-xl bg-shopDeep border border-shopAccent py-3 text-[13px] font-black text-shopAccent shadow-sm transition-colors hover:bg-shopDeep"
                >
                  {editingCouponId !== null ? l('Update Coupon', 'கூப்பனை புதுப்பி') : l('Create Coupon', 'கூப்பனை உருவாக்கு')}
                </button>
              </form>

              <div className="rounded-2xl border border-shopSoft bg-[#FFFCF6] p-4 shadow-sm">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.15em] text-[#6B7280]">{l('Coupon List', 'கூப்பன் பட்டியல்')}</p>
                    <h3 className="mt-1 text-[17px] font-black text-[#111111]">
                      {l('All Coupons', 'அனைத்து கூப்பன்கள்')} <span className="text-[#6B7280]">({coupons.length})</span>
                    </h3>
                  </div>
                  <span className="rounded-full border border-[#E7CFAA] bg-[#FFF6E7] px-2.5 py-0.5 text-[10px] font-black uppercase tracking-[0.15em] text-shopCard">
                    {l('Admin only', 'அட்மின் மட்டும்')}
                  </span>
                </div>

                <div className="space-y-2 max-h-[30rem] overflow-y-auto hide-scrollbar pr-1">
                  {coupons.map((coupon) => {
                    const isExpired = coupon.expiry_date ? new Date(coupon.expiry_date) < new Date() : false
                    const isExhausted = coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit
                    const isEditing = editingCouponId === coupon.id
                    return (
                      <div
                        key={coupon.id}
                        className={`rounded-xl border p-3 shadow-sm transition-all ${
                          isEditing
                            ? 'border-shopCard bg-[#FFF8F3] ring-1 ring-shopCard/15'
                            : 'border-[#F0E2C8] bg-white hover:border-[#D8BA8A]'
                        }`}
                      >
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="truncate text-[15px] font-black uppercase tracking-[0.14em] text-[#111111]">{coupon.code}</p>
                              <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] ${coupon.is_active ? 'bg-[#FCE7EA] text-shopCard' : 'bg-[#F8EDD9] text-[#9A6700]'}`}>
                                {coupon.is_active ? l('Active', 'செயலில்') : l('Inactive', 'செயலற்ற')}
                              </span>
                              {isExpired && (
                                <span className="rounded-full bg-red-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-red-700">
                                  Expired
                                </span>
                              )}
                              {!isExpired && isExhausted && (
                                <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-orange-700">
                                  Limit reached
                                </span>
                              )}
                            </div>

                            <p className="text-[12px] font-semibold text-shopCard">
                              {coupon.percentage}% off
                              {coupon.min_order_value > 0 && ` • min ₹${coupon.min_order_value}`}
                            </p>

                            <p className="text-[11px] text-[#6C665C]">
                              Used {coupon.usage_count}{coupon.usage_limit ? `/${coupon.usage_limit}` : ''} times
                              {coupon.expiry_date ? ` • expires ${new Date(coupon.expiry_date).toLocaleDateString('en-MY')}` : ''}
                            </p>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              onClick={() => void toggleCoupon(coupon)}
                              className={`rounded-full px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] transition-colors ${
                                coupon.is_active ? 'bg-[#FCE7EA] text-shopCard hover:bg-[#F8D7DD]' : 'bg-[#F8EDD9] text-[#9A6700] hover:bg-[#F2E0B9]'
                              }`}
                            >
                              {coupon.is_active ? l('Active', 'செயலில்') : l('Off', 'ஆஃப்')}
                            </button>
                            <button
                              onClick={() => startEditCoupon(coupon)}
                              className="rounded-full border border-shopSoft bg-white p-2 text-shopCard transition-colors hover:border-shopCard hover:text-[#111111]"
                            >
                              <Edit2 size={14} />
                            </button>
                            <button
                              onClick={() => void deleteCoupon(coupon)}
                              className="rounded-full border border-[#F4D4D4] bg-white p-2 text-red-500 transition-colors hover:bg-red-50 hover:text-red-700"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}

                  {coupons.length === 0 && (
                    <div className="rounded-[22px] border border-dashed border-[#E7CFAA] bg-[#FFF8F3] py-12 text-center text-[14px] font-bold text-shopCard">
                      {l('No coupons yet. Create your first coupon!', 'இன்னும் கூப்பன் இல்லை. முதல் கூப்பனை உருவாக்குங்கள்!')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
        
                {tab === 'inventory' && (
          <Inventory />
        )}

        {tab === 'expenses' && (
          <Expenses />
        )}

        {tab === 'store_settings' && role === 'admin' && <StoreSettings />}

        {tab === 'attendance' && (
          <>
            {role === 'admin' ? <Attendance /> : <StaffPunch embedded={true} />}
          </>
        )}
        
        {tab === 'users' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[20px] font-black text-[#111111]">{l('User Management', 'பயனர் மேலாண்மை')}</h2>
              <button onClick={() => void loadUsers()}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-[#F3F4F6] rounded-xl text-[13px] font-bold text-[#111111] hover:bg-[#FAFAFA] transition-colors shadow-sm">
                <RefreshCw size={14} /> Refresh
              </button>
            </div>

            {/* Search */}
            <div className="relative max-w-sm">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#6B7280]" />
              <input
                className="w-full pl-11 pr-4 py-3 bg-white border border-[#D1D5DB] rounded-xl text-[13px] font-bold text-[#111111] placeholder-[#6B7280] focus:outline-none focus:border-maroon-dark transition-colors shadow-sm"
                placeholder={l('Search by name or email...', 'பெயர் அல்லது மின்னஞ்சலால் தேடுக...')}
                value={userSearch}
                onChange={e => setUserSearch(e.target.value)}
              />
            </div>

            {usersError && (
              <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-[13px] text-red-700 font-bold shadow-sm">
                <AlertCircle size={15} /> {usersError}
              </div>
            )}

            <div className="bg-white rounded-2xl border border-borderLight shadow-sm overflow-hidden">
              {usersLoading ? (
                <div className="p-10 text-center text-[13px] font-bold text-[#6B7280]">{l('Loading users...', 'பயனர்கள் ஏற்றுகிறது...')}</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-[14px]">
                    <thead>
                      <tr className="bg-[#FAFAFA] border-b border-borderLight uppercase tracking-wider text-[11px] text-[#6B7280]">
                        <th className="text-left px-6 py-4 font-black">{l('Name', 'பெயர்')}</th>
                        <th className="text-left px-6 py-4 font-black">{l('Email', 'மின்னஞ்சல்')}</th>
                        <th className="text-left px-6 py-4 font-black">{l('Mobile', 'மொபைல்')}</th>
                        <th className="text-left px-6 py-4 font-black">{l('Joined', 'சேர்ந்த தேதி')}</th>
                        <th className="text-center px-6 py-4 font-black">{l('Role', 'பங்கு')}</th>
                        <th className="text-center px-6 py-4 font-black">{l('Action', 'நடவடிக்கை')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F3F4F6]">
                      {allUsers
                        .filter(u => {
                          if (!userSearch.trim()) return true
                          const q = userSearch.toLowerCase()
                          return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
                        })
                        .map(u => (
                          <tr key={u.id} className="hover:bg-[#FAFAFA] transition-colors">
                            <td className="px-6 py-4 font-bold text-[#111111]">{u.name || '-'}</td>
                            <td className="px-6 py-4 text-[#6B7280]">{u.email || '-'}</td>
                            <td className="px-6 py-4 text-[#6B7280]">{u.mobile || '-'}</td>
                            <td className="px-6 py-4 text-[#6B7280] text-[12px]">
                              {u.created_at ? new Date(u.created_at).toLocaleDateString('en-MY') : '-'}
                            </td>
                            <td className="px-6 py-4 text-center">
                              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-wider ${
                                u.role === 'admin'
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-[#F3F4F6] text-[#4B5563]'
                              }`}>
                                {u.role === 'admin' ? <ShieldCheck size={12} /> : <ShieldOff size={12} />}
                                {u.role === 'admin' ? l('Admin', 'நிர்வாகி') : l('Customer', 'வாடிக்கையாளர்')}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-center">
                              {u.id === user?.id ? (
                                <span className="text-[12px] text-[#6B7280] font-bold uppercase tracking-wider">{l('You', 'நீங்கள்')}</span>
                              ) : (
                                <button
                                  onClick={() => void toggleUserRole(u)}
                                  disabled={roleUpdating === u.id}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-black uppercase tracking-wider transition-colors disabled:opacity-50 ${
                                    u.role === 'admin'
                                      ? 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200'
                                      : 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-200'
                                  }`}
                                >
                                  {u.role === 'admin' ? <><ShieldOff size={12} /> Remove Admin</> : <><ShieldCheck size={12} /> {l('Make Admin', 'நிர்வாகி ஆக்கு')}</>}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {allUsers.length === 0 && !usersLoading && (
                    <p className="p-10 text-center text-[14px] font-bold text-[#6B7280] bg-[#FAFAFA]">{l('No users found.', 'பயனர் இல்லை.')}</p>
                  )}
                </div>
              )}
            </div>

            <p className="text-[12px] text-[#6B7280] font-bold">
              - {l('Role changes take effect upon next login.', 'பங்கு மாற்றம் அடுத்த முறை உள்நுழைந்தால் நடைமுறைக்கு வரும்.')}
            </p>
          </div>
        )}
        </div>
        </div>
        {/* Footer */}
        <div className="shrink-0 border-t border-gray-100 bg-white/80 py-2 text-center text-[12px] font-semibold text-[#7A8A78] tracking-wide print:hidden">
          Powered by Cenexa Systems © 2026
        </div>
      </main>


      {invoicePreviewOrder && (() => {
        const preview = getOrderWhatsAppPreview(invoicePreviewOrder)
        if (!preview) return null

        return (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-shopDeep/60 p-3 sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-label={`Invoice ${invoicePreviewOrder.invoice_no || invoicePreviewOrder.id}`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setInvoicePreviewOrder(null)
            }}
          >
            <div className="flex max-h-[97vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-[#F9FAFB] shadow-2xl">
              <div className="flex shrink-0 items-center justify-between border-b border-shopSoft/60 bg-white px-4 py-3 sm:px-6">
                <div>
                  <h2 className="text-base font-black text-[#111111]">Invoice Preview</h2>
                  <p className="text-xs font-semibold text-[#6B7280]">{formatInvoiceNo(invoicePreviewOrder.invoice_no || invoicePreviewOrder.id)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handlePrintReceipt(invoicePreviewOrder)}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-shopSoft/70 px-3 text-xs font-black text-[#111111] hover:bg-[#F9FAFB]"
                  >
                    <Printer size={15} /> Print
                  </button>
                  <button
                    type="button"
                    onClick={() => void openOrderInvoice(invoicePreviewOrder, 'download')}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-maroon-dark px-3 text-xs font-black text-white hover:bg-maroon"
                  >
                    <Download size={15} /> Download
                  </button>
                  <button
                    type="button"
                    onClick={() => setInvoicePreviewOrder(null)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-[#6B7280] hover:bg-[#F9FAFB] hover:text-[#111111]"
                    aria-label="Close invoice preview"
                  >
                    <X size={19} />
                  </button>
                </div>
              </div>
              <div className="overflow-y-auto hide-scrollbar p-2 sm:p-5">
                <div
                  ref={invoicePreviewRef}
                  className="mx-auto flex max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-sm"
                  style={{ minHeight: invoicePreviewMinHeight }}
                >
                  <Invoice
                    invoiceNo={formatInvoiceNo(invoicePreviewOrder.invoice_no || invoicePreviewOrder.id)}
                    date={invoicePreviewOrder.created_at}
                    customerName={invoicePreviewOrder.customer_name}
                    phone={invoicePreviewOrder.phone}
                    address={invoicePreviewOrder.address}
                    items={preview.items as unknown as import('../components/Invoice').InvoiceItem[]}
                    subtotal={preview.subtotal}
                    shipping={invoicePreviewOrder.delivery_charge}
                    deliveryCharge={invoicePreviewOrder.delivery_charge}
                    discountAmount={invoicePreviewOrder.discount_amount}
                    manualDiscountAmount={invoicePreviewOrder.manual_discount_amount}
                    gstAmount={invoicePreviewOrder.total_gst}
                    paymentMode={invoicePreviewOrder.payment_mode}
                    total={invoicePreviewOrder.total}
                    status={invoicePreviewOrder.status}
                  />
                </div>
              </div>
            </div>
          </div>
        )
      })()}

    </div>
  )
}
