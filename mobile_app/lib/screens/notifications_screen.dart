import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/notification_item.dart';
import '../services/api_service.dart';
import '../widgets/state_views.dart';

/// Screen displaying weekly low attendance alerts and notices.
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  List<NotificationItem> _notifications = [];
  bool _loading = true;
  String? _error;
  bool _linked = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    final api = AppScope.read(context).api;
    try {
      final res = await api.getNotifications();
      if (mounted) {
        final list = (res['notifications'] as List? ?? [])
            .map((e) => NotificationItem.fromJson(e as Map<String, dynamic>))
            .toList();
        setState(() {
          _notifications = list;
          _linked = res['linked'] == true;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _markRead(NotificationItem item) async {
    if (item.isRead) return;
    final api = AppScope.read(context).api;
    try {
      await api.markNotificationRead(item.id);
      setState(() {
        final index = _notifications.indexWhere((n) => n.id == item.id);
        if (index != -1) {
          _notifications[index] = NotificationItem(
            id: item.id,
            studentId: item.studentId,
            subjectCode: item.subjectCode,
            subjectName: item.subjectName,
            attendancePercentage: item.attendancePercentage,
            threshold: item.threshold,
            weekId: item.weekId,
            warningType: item.warningType,
            title: item.title,
            message: item.message,
            reportingDate: item.reportingDate,
            createdAt: item.createdAt,
            isRead: true,
          );
        }
      });
    } on ApiException {
      // Ignored non-critical failure
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Attendance Notices'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      body: _loading
          ? const LoadingView(message: 'Checking weekly warnings...')
          : _error != null
              ? MessageView(
                  icon: Icons.error_outline_rounded,
                  title: 'Could not load notices',
                  message: _error!,
                  actionLabel: 'Try again',
                  onAction: _load,
                  isError: true,
                )
              : !_linked
                  ? const MessageView(
                      icon: Icons.link_off_rounded,
                      title: 'Account Not Linked',
                      message:
                          'Your account is not linked to a student record. Weekly attendance checks only apply to linked students.',
                    )
                  : _notifications.isEmpty
                      ? const MessageView(
                          icon: Icons.verified_rounded,
                          title: 'All Attendance Healthy',
                          message:
                            'No low attendance warnings for your account. Keep your attendance at 75% or above!',
                        )
                      : RefreshIndicator(
                          onRefresh: _load,
                          child: ListView.separated(
                            padding: const EdgeInsets.all(16),
                            itemCount: _notifications.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(height: 12),
                            itemBuilder: (context, index) {
                              final notif = _notifications[index];
                              return _WarningCard(
                                notif: notif,
                                onTap: () => _markRead(notif),
                              );
                            },
                          ),
                        ),
    );
  }
}

class _WarningCard extends StatelessWidget {
  const _WarningCard({required this.notif, required this.onTap});

  final NotificationItem notif;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final isUnread = !notif.isRead;

    return Card(
      elevation: isUnread ? 2 : 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(
          color: isUnread ? Colors.amber.shade700 : scheme.outlineVariant,
          width: isUnread ? 1.5 : 1.0,
        ),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: Colors.red.shade50,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Icon(
                      Icons.warning_amber_rounded,
                      color: Colors.red.shade700,
                      size: 24,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                notif.title,
                                style: theme.textTheme.titleSmall?.copyWith(
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            if (isUnread)
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 8, vertical: 2),
                                decoration: BoxDecoration(
                                  color: Colors.red.shade100,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Text(
                                  'NEW',
                                  style: TextStyle(
                                    color: Colors.red.shade900,
                                    fontSize: 10,
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${notif.subjectName} (${notif.subjectCode})',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: scheme.onSurfaceVariant,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                notif.message,
                style: theme.textTheme.bodyMedium?.copyWith(
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.red.shade100,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      '${notif.attendancePercentage}% (Min: ${notif.threshold}%)',
                      style: TextStyle(
                        color: Colors.red.shade900,
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                      ),
                    ),
                  ),
                  Text(
                    'Week ${notif.weekId} • ${notif.reportingDate}',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
