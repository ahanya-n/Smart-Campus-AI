import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/timetable.dart';
import '../services/api_service.dart';
import '../widgets/demo_banner.dart';
import '../widgets/state_views.dart';

/// Weekly timetable from GET /timetable, opened on today's day.
class TimetableScreen extends StatefulWidget {
  const TimetableScreen({super.key, this.initialDay});

  /// Day selected first; defaults to today (Monday on Sundays).
  final String? initialDay;

  @override
  State<TimetableScreen> createState() => _TimetableScreenState();
}

class _TimetableScreenState extends State<TimetableScreen> {
  late final String _today = defaultTimetableDay(DateTime.now());
  late final bool _todayIsClassDay = DateTime.now().weekday <= weekDays.length;
  late String _selectedDay = widget.initialDay ?? _today;

  TimetableData? _data;
  String? _error;
  bool _loading = false;
  bool _demo = false;

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

    final scope = AppScope.read(context);
    try {
      final data = await scope.api.getTimetable(demo: _demo);
      if (mounted) setState(() => _data = data);
    } on ApiException catch (e) {
      if (e.isUnauthorized) {
        await scope.auth.logout();
        return;
      }
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _setDemo(bool demo) {
    setState(() {
      _demo = demo;
      _data = null;
    });
    _load();
  }

  bool _isToday(String day) => _todayIsClassDay && day == _today;

  Future<void> _addClassDialog() async {
    final auth = AppScope.read(context).auth;
    final user = auth.user;
    final assigned = user?.assignedSubjectCodes ?? [];

    String selectedDay = _selectedDay;
    final deptCtrl = TextEditingController(text: 'MCA');
    final semCtrl = TextEditingController(text: '1');
    final codeCtrl = TextEditingController(text: assigned.isNotEmpty ? assigned.first : '');
    final nameCtrl = TextEditingController();
    final startCtrl = TextEditingController(text: '09:00');
    final endCtrl = TextEditingController(text: '10:00');
    final roomCtrl = TextEditingController(text: 'LH-101');
    final facultyCtrl = TextEditingController(text: user?.isAdmin == true ? '' : (user?.name ?? ''));

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Add Timetable Class'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: selectedDay,
                  decoration: const InputDecoration(labelText: 'Day of Week'),
                  items: weekDays.map((d) => DropdownMenuItem(value: d, child: Text(d))).toList(),
                  onChanged: (val) {
                    if (val != null) setDialogState(() => selectedDay = val);
                  },
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: deptCtrl,
                        decoration: const InputDecoration(labelText: 'Department', hintText: 'MCA'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextField(
                        controller: semCtrl,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(labelText: 'Semester', hintText: '1'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                if (assigned.isNotEmpty && user?.isFaculty == true)
                  DropdownButtonFormField<String>(
                    initialValue: codeCtrl.text,
                    decoration: const InputDecoration(labelText: 'Subject Code'),
                    items: assigned.map((c) => DropdownMenuItem(value: c, child: Text(c))).toList(),
                    onChanged: (val) {
                      if (val != null) codeCtrl.text = val;
                    },
                  )
                else
                  TextField(
                    controller: codeCtrl,
                    decoration: const InputDecoration(labelText: 'Subject Code', hintText: 'MCA101'),
                  ),
                const SizedBox(height: 10),
                TextField(
                  controller: nameCtrl,
                  decoration: const InputDecoration(labelText: 'Subject Name', hintText: 'Data Structures'),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: startCtrl,
                        decoration: const InputDecoration(labelText: 'Start (HH:MM)', hintText: '09:00'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextField(
                        controller: endCtrl,
                        decoration: const InputDecoration(labelText: 'End (HH:MM)', hintText: '10:00'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: roomCtrl,
                  decoration: const InputDecoration(labelText: 'Room Number', hintText: 'LH-101'),
                ),
                if (user?.isAdmin == true) ...[
                  const SizedBox(height: 10),
                  TextField(
                    controller: facultyCtrl,
                    decoration: const InputDecoration(labelText: 'Faculty Name', hintText: 'Prof. Sharma'),
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Add Class'),
            ),
          ],
        ),
      ),
    );

    if (!mounted) return;
    if (confirmed == true) {
      final sem = int.tryParse(semCtrl.text.trim()) ?? 1;
      final payload = <String, dynamic>{
        'department': deptCtrl.text.trim().toUpperCase(),
        'semester': sem,
        'day_of_week': selectedDay,
        'subject_code': codeCtrl.text.trim().toUpperCase(),
        'subject_name': nameCtrl.text.trim().isEmpty ? codeCtrl.text.trim().toUpperCase() : nameCtrl.text.trim(),
        'start_time': startCtrl.text.trim(),
        'end_time': endCtrl.text.trim(),
        'room_number': roomCtrl.text.trim(),
      };
      if (facultyCtrl.text.trim().isNotEmpty) {
        payload['faculty_name'] = facultyCtrl.text.trim();
      }

      final api = AppScope.read(context).api;
      try {
        await api.createTimetableEntry(payload);
        _load();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Class added to schedule')),
          );
        }
      } on ApiException catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: Colors.red),
          );
        }
      }
    }
  }

  Future<void> _deleteClass(TimetableEntry entry) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Class?'),
        content: Text('Remove ${entry.subjectCode} (${entry.startTime}-${entry.endTime}) from ${entry.dayOfWeek}?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (!mounted) return;
    if (confirmed == true) {
      final api = AppScope.read(context).api;
      try {
        await api.deleteTimetableEntry(entry.id);
        _load();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Class removed from schedule')),
          );
        }
      } on ApiException catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: Colors.red),
          );
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = AppScope.read(context).auth;
    final user = auth.user;
    final canManage = user != null && (user.isAdmin || user.isFaculty) && !_demo;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Timetable'),
        actions: [
          if (_demo)
            IconButton(
              tooltip: 'Exit demo',
              onPressed: _loading ? null : () => _setDemo(false),
              icon: const Icon(Icons.close_rounded),
            )
          else if (_data?.linked ?? false)
            IconButton(
              tooltip: 'View Demo Data',
              onPressed: _loading ? null : () => _setDemo(true),
              icon: const Icon(Icons.science_outlined),
            ),
          if (_data?.isDemo ?? false)
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: Center(child: DemoChip()),
            ),
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _buildBody(),
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              icon: const Icon(Icons.add_rounded),
              label: const Text('Add Class'),
              onPressed: _addClassDialog,
            )
          : null,
    );
  }

  Widget _buildBody() {
    final data = _data;

    if (data == null) {
      if (_error != null) {
        return MessageView(
          icon: Icons.cloud_off_rounded,
          title: "Couldn't load timetable",
          message: _error!,
          actionLabel: 'Try again',
          onAction: _load,
          isError: true,
        );
      }
      return const LoadingView(message: 'Loading timetable...');
    }

    if (!data.linked && !_demo) {
      return MessageView(
        icon: Icons.link_off_rounded,
        title: 'Account not linked',
        message:
            data.message ?? 'Your account is not linked to a student record.',
        actionLabel: 'View demo data',
        actionIcon: Icons.science_outlined,
        onAction: () => _setDemo(true),
      );
    }

    final classes = data.entriesFor(_selectedDay);
    final now = DateTime.now();

    return Column(
      children: [
        if (data.isDemo)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: DemoBanner(
              message: data.message ??
                  'Sample timetable for demonstration, not the official schedule.',
              onExit: _demo ? () => _setDemo(false) : null,
            ),
          ),
        _DaySelector(
          selectedDay: _selectedDay,
          today: _todayIsClassDay ? _today : null,
          countFor: (day) => data.entriesFor(day).length,
          onSelected: (day) => setState(() => _selectedDay = day),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
          child: Row(
            children: [
              Text(
                _selectedDay,
                style: Theme.of(context)
                    .textTheme
                    .titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              if (_isToday(_selectedDay)) ...[
                const SizedBox(width: 8),
                const _Pill(label: 'Today'),
              ],
              const Spacer(),
              Text(
                '${classes.length} ${classes.length == 1 ? 'class' : 'classes'}',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: classes.isEmpty
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    children: [
                      const SizedBox(height: 40),
                      MessageView(
                        icon: Icons.event_available_rounded,
                        title: 'No classes',
                        message: data.entries.isEmpty
                            ? (data.message ?? 'No timetable entries yet.')
                            : 'There are no classes on $_selectedDay.',
                        actionLabel: (data.entries.isEmpty && !_demo)
                            ? 'View demo data'
                            : null,
                        actionIcon: Icons.science_outlined,
                        onAction: (data.entries.isEmpty && !_demo)
                            ? () => _setDemo(true)
                            : null,
                      ),
                    ],
                  )
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                    itemCount: classes.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 12),
                    itemBuilder: (context, index) {
                      final entry = classes[index];
                      final auth = AppScope.read(context).auth;
                      final user = auth.user;
                      final canDelete = user != null && (user.isAdmin || user.isFaculty) && !_demo && !entry.isDemo;
                      return _ClassCard(
                        entry: entry,
                        ongoing:
                            _isToday(_selectedDay) && entry.isOngoing(now),
                        onDelete: canDelete ? () => _deleteClass(entry) : null,
                      );
                    },
                  ),
          ),
        ),
      ],
    );
  }
}

class _DaySelector extends StatelessWidget {
  const _DaySelector({
    required this.selectedDay,
    required this.today,
    required this.countFor,
    required this.onSelected,
  });

  final String selectedDay;
  final String? today;
  final int Function(String day) countFor;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return SizedBox(
      height: 84,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        itemCount: weekDays.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final day = weekDays[index];
          final selected = day == selectedDay;
          final isToday = day == today;
          final foreground = selected ? scheme.onPrimary : scheme.onSurface;

          return Material(
            color: selected ? scheme.primary : scheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(16),
            child: InkWell(
              key: Key('day_${day.substring(0, 3)}'),
              borderRadius: BorderRadius.circular(16),
              onTap: () => onSelected(day),
              child: Container(
                width: 56,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  border: isToday && !selected
                      ? Border.all(color: scheme.primary, width: 2)
                      : null,
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      day.substring(0, 3),
                      style: theme.textTheme.titleSmall?.copyWith(
                        color: foreground,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${countFor(day)}',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: foreground.withValues(alpha: 0.8),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _ClassCard extends StatelessWidget {
  const _ClassCard({
    required this.entry,
    required this.ongoing,
    this.onDelete,
  });

  final TimetableEntry entry;
  final bool ongoing;
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Card(
      shape: ongoing
          ? RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
              side: BorderSide(color: scheme.primary, width: 2),
            )
          : null,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                width: 56,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      entry.startTime,
                      style: theme.textTheme.titleSmall
                          ?.copyWith(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      entry.endTime,
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              Container(
                width: 4,
                margin: const EdgeInsets.symmetric(horizontal: 12),
                decoration: BoxDecoration(
                  color: scheme.primary,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Text(
                            entry.subjectName,
                            style: theme.textTheme.titleSmall
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                        ),
                        if (ongoing) const _Pill(label: 'Now'),
                        if (onDelete != null) ...[
                          const SizedBox(width: 4),
                          IconButton(
                            icon: const Icon(Icons.delete_outline_rounded, size: 20),
                            color: Colors.red.shade400,
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints(),
                            tooltip: 'Delete class',
                            onPressed: onDelete,
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      entry.subjectCode,
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: 8),
                    _Detail(icon: Icons.person_outline_rounded, text: entry.facultyName),
                    const SizedBox(height: 4),
                    _Detail(icon: Icons.meeting_room_outlined, text: 'Room ${entry.roomNumber}'),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Detail extends StatelessWidget {
  const _Detail({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        Icon(icon, size: 16, color: scheme.onSurfaceVariant),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            text,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context)
                .textTheme
                .bodyMedium
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: scheme.primaryContainer,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: scheme.onPrimaryContainer,
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
