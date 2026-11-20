import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/transport.dart';
import '../services/api_service.dart';

class TransportScreen extends StatefulWidget {
  const TransportScreen({super.key});

  @override
  State<TransportScreen> createState() => _TransportScreenState();
}

class _TransportScreenState extends State<TransportScreen> {
  final List<TransportRoute> _routes = [];
  StudentTransportDetails? _studentTransport;
  bool _loading = true;
  String? _error;
  String? _workingId;

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
    try {
      final scope = AppScope.read(context);
      final api = scope.api;
      final isStudent = scope.auth.user?.isStudent == true;
      final routes = await api.getTransportRoutes();
      final studentTransport = isStudent ? await api.getMyTransport() : null;
      if (!mounted) return;
      setState(() {
        _routes
          ..clear()
          ..addAll(routes);
        _studentTransport = studentTransport;
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } on FormatException {
      if (mounted) setState(() => _error = 'Unable to load transport details.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _perform(
    String id,
    Future<void> Function() action,
    String message,
  ) async {
    setState(() {
      _workingId = id;
      _error = null;
    });
    try {
      await action();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(message)));
      await _load();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } on FormatException {
      if (mounted) {
        setState(() => _error = 'Unable to complete this transport request.');
      }
    } finally {
      if (mounted) setState(() => _workingId = null);
    }
  }

  Future<void> _createRoute() async {
    final draft = await showDialog<TransportRouteDraft>(
      context: context,
      builder: (_) => const _TransportRouteDialog(),
    );
    if (draft == null || !mounted) return;
    await _perform(
      'create',
      () async => AppScope.read(context).api.createTransportRoute(draft),
      'Transport route added.',
    );
  }

  Future<void> _editRoute(TransportRoute route) async {
    final draft = await showDialog<TransportRouteDraft>(
      context: context,
      builder: (_) => _TransportRouteDialog(route: route),
    );
    if (draft == null || !mounted) return;
    await _perform(
      'edit-${route.id}',
      () async =>
          AppScope.read(context).api
              .updateTransportRoute(routeId: route.id, route: draft),
      'Transport route updated.',
    );
  }

  Future<void> _assignStudent(TransportRoute route) async {
    final assignment = await showDialog<_AssignmentDraft>(
      context: context,
      builder: (_) => _AssignmentDialog(route: route),
    );
    if (assignment == null || !mounted) return;
    await _perform(
      'assign-${route.id}',
      () => AppScope.read(context).api.assignStudentToTransport(
        routeId: route.id,
        studentId: assignment.studentId,
        pickupPoint: assignment.pickupPoint,
        dropPoint: assignment.dropPoint,
      ),
      'Student assigned to transport.',
    );
  }

  Future<void> _removeStudent(
    TransportRoute route,
    TransportAssignment assignment,
  ) async {
    await _perform(
      'remove-${route.id}-${assignment.studentId}',
      () => AppScope.read(context).api.removeStudentFromTransport(
        routeId: route.id,
        studentId: assignment.studentId,
      ),
      'Student removed from the route.',
    );
  }

  Future<void> _deleteRoute(TransportRoute route) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete transport route?'),
        content: Text(
          'Delete route ${route.routeNumber}? Assigned routes cannot be deleted.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _perform(
      'delete-${route.id}',
      () => AppScope.read(context).api.deleteTransportRoute(route.id),
      'Transport route deleted.',
    );
  }

  @override
  Widget build(BuildContext context) {
    final user = AppScope.of(context).auth.user;
    final isAdmin = user?.isAdmin == true;
    final isStudent = user?.isStudent == true;
    final student = _studentTransport;
    final assigned = _routes.fold<int>(
      0,
      (total, route) => total + route.assignedSeats,
    );
    final available = _routes.fold<int>(
      0,
      (total, route) => total + route.availableSeats,
    );

    return Scaffold(
      appBar: AppBar(
        title: const Text('Transport'),
        actions: [
          if (isAdmin)
            IconButton(
              tooltip: 'Add route',
              onPressed: _workingId == null ? _createRoute : null,
              icon: const Icon(Icons.add),
            ),
          IconButton(
            tooltip: 'Refresh transport',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: _loading && _routes.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: [
                  const Text(
                    'Transport dashboard',
                    style: TextStyle(fontSize: 21, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 12),
                  _TransportSummary(
                    routes: _routes.length,
                    assigned: assigned,
                    available: available,
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Card(
                      color: Theme.of(context).colorScheme.errorContainer,
                      child: ListTile(
                        leading: const Icon(Icons.error_outline),
                        title: Text(_error!),
                        trailing: TextButton(
                          onPressed: _loading ? null : _load,
                          child: const Text('Retry'),
                        ),
                      ),
                    ),
                  ],
                  if (isStudent) ...[
                    const SizedBox(height: 20),
                    Text(
                      'My transport',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    if (student?.assigned == true &&
                        student?.route != null &&
                        student?.assignment != null)
                      _StudentTransportCard(
                        route: student!.route!,
                        assignment: student.assignment!,
                      )
                    else
                      const _EmptyTransport(
                        message: 'No transport assignment is recorded for your account.',
                      ),
                  ],
                  const SizedBox(height: 20),
                  Text(
                    'Bus routes',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  if (_routes.isEmpty)
                    const _EmptyTransport(
                      message: 'No transport routes have been configured.',
                    )
                  else
                    for (final route in _routes)
                      _RouteCard(
                        route: route,
                        isAdmin: isAdmin,
                        working: _workingId != null,
                        onEdit: () => _editRoute(route),
                        onAssign: () => _assignStudent(route),
                        onDelete: () => _deleteRoute(route),
                        onRemove: (assignment) =>
                            _removeStudent(route, assignment),
                      ),
                ],
              ),
            ),
    );
  }
}

class _TransportSummary extends StatelessWidget {
  const _TransportSummary({
    required this.routes,
    required this.assigned,
    required this.available,
  });

  final int routes;
  final int assigned;
  final int available;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceAround,
          children: [
            _SummaryValue(label: 'Routes', value: routes),
            _SummaryValue(label: 'Assigned', value: assigned),
            _SummaryValue(label: 'Seats free', value: available),
          ],
        ),
      ),
    );
  }
}

class _SummaryValue extends StatelessWidget {
  const _SummaryValue({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text('$value', style: Theme.of(context).textTheme.titleLarge),
        Text(label, style: Theme.of(context).textTheme.labelSmall),
      ],
    );
  }
}

class _RouteCard extends StatelessWidget {
  const _RouteCard({
    required this.route,
    required this.isAdmin,
    required this.working,
    required this.onEdit,
    required this.onAssign,
    required this.onDelete,
    required this.onRemove,
  });

  final TransportRoute route;
  final bool isAdmin;
  final bool working;
  final VoidCallback onEdit;
  final VoidCallback onAssign;
  final VoidCallback onDelete;
  final ValueChanged<TransportAssignment> onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 5),
      child: ExpansionTile(
        leading: Icon(Icons.directions_bus_rounded, color: colors.primary),
        title: Text('Route ${route.routeNumber} · ${route.busNumber}'),
        subtitle: Text(
          '${route.registrationNumber} · ${route.availableSeats} of ${route.capacity} seats available',
        ),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _DetailLine(label: 'Driver', value: route.driver.name),
                if (isAdmin && route.driver.phone != null)
                  _DetailLine(
                    label: 'Driver contact',
                    value: route.driver.phone!,
                  ),
                _DetailLine(
                  label: 'Pickup points',
                  value: route.pickupPoints.join(' · '),
                ),
                _DetailLine(
                  label: 'Drop points',
                  value: route.dropPoints.join(' · '),
                ),
                if (isAdmin) ...[
                  const Divider(height: 24),
                  Text(
                    'Assigned students (${route.assignedSeats})',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  if (route.assignments.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: Text('No students are assigned to this route.'),
                    )
                  else
                    for (final assignment in route.assignments)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(assignment.studentId),
                        subtitle: Text(
                          '${assignment.pickupPoint} → ${assignment.dropPoint}',
                        ),
                        trailing: IconButton(
                          tooltip: 'Remove student assignment',
                          onPressed: working
                              ? null
                              : () => onRemove(assignment),
                          icon: const Icon(Icons.person_remove_outlined),
                        ),
                      ),
                  Wrap(
                    spacing: 8,
                    children: [
                      if (route.availableSeats > 0)
                        OutlinedButton.icon(
                          onPressed: working ? null : onAssign,
                          icon: const Icon(Icons.person_add_alt_1),
                          label: const Text('Assign student'),
                        ),
                      OutlinedButton.icon(
                        onPressed: working ? null : onEdit,
                        icon: const Icon(Icons.edit_outlined),
                        label: const Text('Edit route'),
                      ),
                      if (route.assignedSeats == 0)
                        TextButton.icon(
                          onPressed: working ? null : onDelete,
                          icon: const Icon(Icons.delete_outline),
                          label: const Text('Delete'),
                        ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  const _DetailLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Text('$label: $value'),
    );
  }
}

class _StudentTransportCard extends StatelessWidget {
  const _StudentTransportCard({required this.route, required this.assignment});

  final TransportRoute route;
  final TransportAssignment assignment;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Route ${route.routeNumber} · ${route.busNumber}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            _DetailLine(label: 'Registration', value: route.registrationNumber),
            _DetailLine(label: 'Pickup', value: assignment.pickupPoint),
            _DetailLine(label: 'Drop', value: assignment.dropPoint),
            _DetailLine(label: 'Driver', value: route.driver.name),
          ],
        ),
      ),
    );
  }
}

class _EmptyTransport extends StatelessWidget {
  const _EmptyTransport({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(18),
      child: Center(child: Text(message, textAlign: TextAlign.center)),
    ),
  );
}

class _TransportRouteDialog extends StatefulWidget {
  const _TransportRouteDialog({this.route});

  final TransportRoute? route;

  @override
  State<_TransportRouteDialog> createState() => _TransportRouteDialogState();
}

class _TransportRouteDialogState extends State<_TransportRouteDialog> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _routeNumber;
  late final TextEditingController _busNumber;
  late final TextEditingController _registration;
  late final TextEditingController _pickup;
  late final TextEditingController _drop;
  late final TextEditingController _driver;
  late final TextEditingController _phone;
  late final TextEditingController _capacity;

  @override
  void initState() {
    super.initState();
    final route = widget.route;
    _routeNumber = TextEditingController(text: route?.routeNumber ?? '');
    _busNumber = TextEditingController(text: route?.busNumber ?? '');
    _registration = TextEditingController(
      text: route?.registrationNumber ?? '',
    );
    _pickup = TextEditingController(text: route?.pickupPoints.join(', ') ?? '');
    _drop = TextEditingController(text: route?.dropPoints.join(', ') ?? '');
    _driver = TextEditingController(text: route?.driver.name ?? '');
    _phone = TextEditingController(text: route?.driver.phone ?? '');
    _capacity = TextEditingController(text: '${route?.capacity ?? 40}');
  }

  @override
  void dispose() {
    _routeNumber.dispose();
    _busNumber.dispose();
    _registration.dispose();
    _pickup.dispose();
    _drop.dispose();
    _driver.dispose();
    _phone.dispose();
    _capacity.dispose();
    super.dispose();
  }

  List<String>? _points(String value) {
    final points = value.split(',').map((point) => point.trim()).toList();
    if (points.isEmpty ||
        points.length > 30 ||
        points.any((point) => point.isEmpty || point.length > 100) ||
        points.map((point) => point.toLowerCase()).toSet().length !=
            points.length) {
      return null;
    }
    return points;
  }

  String? _required(String? value, String label, int maxLength) {
    final text = value?.trim() ?? '';
    if (text.isEmpty || text.length > maxLength) {
      return '$label is required (maximum $maxLength characters).';
    }
    return null;
  }

  String? _validatePoints(String? value) => _points(value ?? '') == null
      ? 'Enter 1-30 unique points, separated by commas.'
      : null;

  String? _validatePhone(String? value) {
    final phone = value?.trim() ?? '';
    final digits = phone.replaceAll(RegExp(r'\D'), '').length;
    if (!RegExp(r'^[+0-9() -]{7,24}$').hasMatch(phone) ||
        digits < 7 ||
        digits > 15) {
      return 'Enter a valid phone number.';
    }
    return null;
  }

  void _save() {
    if (!_formKey.currentState!.validate()) return;
    Navigator.pop(
      context,
      TransportRouteDraft(
        routeNumber: _routeNumber.text.trim(),
        busNumber: _busNumber.text.trim(),
        registrationNumber: _registration.text.trim(),
        pickupPoints: _points(_pickup.text)!,
        dropPoints: _points(_drop.text)!,
        driverName: _driver.text.trim(),
        driverPhone: _phone.text.trim(),
        capacity: int.parse(_capacity.text),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(
        widget.route == null ? 'Add transport route' : 'Edit transport route',
      ),
      content: SizedBox(
        width: 440,
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _RouteTextField(
                  controller: _routeNumber,
                  label: 'Route number',
                  validator: (value) => _required(value, 'Route number', 20),
                  pattern: r'^[A-Za-z0-9-]+$',
                ),
                _RouteTextField(
                  controller: _busNumber,
                  label: 'Bus number',
                  validator: (value) => _required(value, 'Bus number', 20),
                ),
                _RouteTextField(
                  controller: _registration,
                  label: 'Registration number',
                  validator: (value) =>
                      _required(value, 'Registration number', 20),
                ),
                _RouteTextField(
                  controller: _pickup,
                  label: 'Pickup points (comma-separated)',
                  validator: _validatePoints,
                ),
                _RouteTextField(
                  controller: _drop,
                  label: 'Drop points (comma-separated)',
                  validator: _validatePoints,
                ),
                _RouteTextField(
                  controller: _driver,
                  label: 'Driver name',
                  validator: (value) => _required(value, 'Driver name', 100),
                ),
                _RouteTextField(
                  controller: _phone,
                  label: 'Driver phone',
                  validator: _validatePhone,
                ),
                _RouteTextField(
                  controller: _capacity,
                  label: 'Bus capacity',
                  keyboardType: TextInputType.number,
                  validator: (value) {
                    final capacity = int.tryParse(value ?? '');
                    return capacity == null || capacity < 1 || capacity > 100
                        ? 'Capacity must be from 1 to 100.'
                        : null;
                  },
                ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _save, child: const Text('Save')),
      ],
    );
  }
}

class _RouteTextField extends StatelessWidget {
  const _RouteTextField({
    required this.controller,
    required this.label,
    required this.validator,
    this.keyboardType,
    this.pattern,
  });

  final TextEditingController controller;
  final String label;
  final String? Function(String?) validator;
  final TextInputType? keyboardType;
  final String? pattern;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: TextFormField(
      controller: controller,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      keyboardType: keyboardType,
      maxLength: label.contains('points') ? 3000 : null,
      validator: (value) {
        final error = validator(value);
        if (error != null) return error;
        if (pattern != null && !RegExp(pattern!).hasMatch(value!.trim())) {
          return 'Use letters, numbers, and hyphens only.';
        }
        return null;
      },
    ),
  );
}

class _AssignmentDraft {
  const _AssignmentDraft(this.studentId, this.pickupPoint, this.dropPoint);

  final String studentId;
  final String pickupPoint;
  final String dropPoint;
}

class _AssignmentDialog extends StatefulWidget {
  const _AssignmentDialog({required this.route});

  final TransportRoute route;

  @override
  State<_AssignmentDialog> createState() => _AssignmentDialogState();
}

class _AssignmentDialogState extends State<_AssignmentDialog> {
  final _formKey = GlobalKey<FormState>();
  final _studentId = TextEditingController();
  late String _pickup = widget.route.pickupPoints.first;
  late String _drop = widget.route.dropPoints.first;

  @override
  void dispose() {
    _studentId.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Assign student to ${widget.route.routeNumber}'),
      content: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextFormField(
              controller: _studentId,
              maxLength: 50,
              decoration: const InputDecoration(
                labelText: 'Existing student ID',
              ),
              validator: (value) =>
                  RegExp(r'^[A-Za-z0-9-]{1,50}$').hasMatch(value?.trim() ?? '')
                  ? null
                  : 'Enter a valid student ID.',
            ),
            DropdownButtonFormField<String>(
              initialValue: _pickup,
              decoration: const InputDecoration(labelText: 'Pickup point'),
              items: widget.route.pickupPoints
                  .map(
                    (point) =>
                        DropdownMenuItem(value: point, child: Text(point)),
                  )
                  .toList(),
              onChanged: (value) {
                if (value != null) setState(() => _pickup = value);
              },
            ),
            DropdownButtonFormField<String>(
              initialValue: _drop,
              decoration: const InputDecoration(labelText: 'Drop point'),
              items: widget.route.dropPoints
                  .map(
                    (point) =>
                        DropdownMenuItem(value: point, child: Text(point)),
                  )
                  .toList(),
              onChanged: (value) {
                if (value != null) setState(() => _drop = value);
              },
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            if (!_formKey.currentState!.validate()) return;
            Navigator.pop(
              context,
              _AssignmentDraft(_studentId.text.trim(), _pickup, _drop),
            );
          },
          child: const Text('Assign'),
        ),
      ],
    );
  }
}
